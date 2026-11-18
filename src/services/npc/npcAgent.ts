import type { NPCEntry, NPCBehavioralTrigger } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

/**
 * The NPC editor's "ask an agent" path.
 *
 * The agent proposes a patch; it never writes. Every change is validated against a
 * whitelist of *existing* authorial fields, because the ledger is campaign data the
 * player has curated — an unknown key or a schema invention would silently rot the
 * record. The UI shows the merged result in the normal form, so the player still
 * saves deliberately.
 */

/** Authorial fields an agent may rewrite. No ids, no flags, no engine state. */
export const NPC_AGENT_FIELDS = [
    'name', 'aliases', 'appearance', 'artStyle', 'faction', 'storyRelevance',
    'status', 'voice', 'personality', 'exampleOutput', 'tier', 'condition',
    'wants.long', 'wants.medium', 'wants.short',
    'hardBoundaries', 'softBoundaries', 'behavioralTriggers',
] as const;

export type NpcAgentField = typeof NPC_AGENT_FIELDS[number];

export type NpcAgentChange = {
    field: string;
    to: unknown;
    why?: string;
};

export type NpcAgentResult = {
    assessment: string;
    changes: NpcAgentChange[];
    questions: string[];
};

const STRING_FIELDS = new Set<string>([
    'name', 'aliases', 'appearance', 'artStyle', 'faction', 'storyRelevance',
    'status', 'voice', 'personality', 'exampleOutput', 'tier', 'condition',
]);

const ARRAY_FIELDS = new Set<string>(['hardBoundaries', 'softBoundaries']);
const WANTS_ARRAY_FIELDS = new Set<string>(['wants.long', 'wants.medium', 'wants.short']);
const TRIGGER_FIELDS = new Set<string>(['behavioralTriggers']);

export const MAX_AGENT_CHANGES = 24;

/** A compact, readable view of one NPC for the prompt. */
export function npcAgentSummary(npc: NPCEntry): string {
    const parts = [`name: ${npc.name}`];
    if (npc.aliases) parts.push(`aliases: ${npc.aliases}`);
    if (npc.appearance) parts.push(`appearance: ${npc.appearance}`);
    if (npc.faction) parts.push(`faction: ${npc.faction}`);
    if (npc.status) parts.push(`status: ${npc.status}`);
    if (npc.storyRelevance) parts.push(`storyRelevance: ${npc.storyRelevance}`);
    if (npc.personality) parts.push(`personality: ${npc.personality}`);
    if (npc.voice) parts.push(`voice: ${npc.voice}`);
    if (npc.wants?.long) parts.push(`wants.long: ${npc.wants.long}`);
    if (npc.wants?.medium?.length) parts.push(`wants.medium: ${npc.wants.medium.join(' | ')}`);
    if (npc.wants?.short?.length) parts.push(`wants.short: ${npc.wants.short.join(' | ')}`);
    if (npc.hardBoundaries?.length) parts.push(`hardBoundaries: ${npc.hardBoundaries.join(' | ')}`);
    if (npc.softBoundaries?.length) parts.push(`softBoundaries: ${npc.softBoundaries.join(' | ')}`);
    if (npc.behavioralTriggers?.length) {
        parts.push(`behavioralTriggers: ${npc.behavioralTriggers.map(t => `${t.keyword} → ${t.shift}`).join(' | ')}`);
    }
    return parts.join('\n');
}

export function buildNpcAgentPrompt(opts: {
    npc: NPCEntry;
    otherNpcs: readonly NPCEntry[];
    place?: string;
    recentBeats?: readonly string[];
    instruction: string;
}): string {
    const others = opts.otherNpcs.length > 0
        ? opts.otherNpcs.map(other => `- ${other.name}${other.faction ? ` (${other.faction})` : ''}${other.status ? ` — ${other.status}` : ''}`).join('\n')
        : '(none)';
    const beats = opts.recentBeats?.length ? opts.recentBeats.join('\n') : '(not supplied)';

    return `You are editing one character record in a long-running interactive story. You are an editor, not a narrator: you return structured edits, never prose and never a rewritten record.

[CURRENT RECORD — edit these fields only]
${npcAgentSummary(opts.npc)}

[OTHER CHARACTERS IN THIS CAMPAIGN]
${others}

[CURRENT PLACE]
${opts.place || '(unknown)'}

[RECENT BEATS]
${beats}

[PLAYER'S INSTRUCTION]
${opts.instruction}

Produce a patch. Rules:
- Only these field paths are accepted: ${NPC_AGENT_FIELDS.join(', ')}.
- "wants.long" is a string; "wants.medium" and "wants.short" are arrays of short strings (max 3); "hardBoundaries"/"softBoundaries" are arrays of short strings (max 5); "behavioralTriggers" is an array of {"keyword","shift"} (max 6).
- Rewrite a field only when the instruction or the record's own contradictions require it. Every change must be justified in "why".
- If the instruction asks about consistency (does this want make sense?), say so in "assessment" and change nothing unless something is actually contradictory.
- If the instruction is ambiguous or depends on facts you were not given (which sibling, what the player once did), put it in "questions" instead of guessing.
- Keep the character's established voice and station. Age and physical detail belong in "appearance" or "personality" as plain prose; there is no numeric age field.
- Names must stay unique across the campaign.

Return JSON only:
{"assessment":"one or two sentences","changes":[{"field":"wants.short","to":["…"],"why":"…"}],"questions":["…"]}`;
}

function asStringArray(value: unknown, max: number): string[] | null {
    if (!Array.isArray(value)) return null;
    const out = value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean);
    if (out.length !== value.length) return null;
    return out.slice(0, max);
}

function asTriggers(value: unknown): NPCBehavioralTrigger[] | null {
    if (!Array.isArray(value)) return null;
    const out: NPCBehavioralTrigger[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        if (typeof record.keyword !== 'string' || typeof record.shift !== 'string') return null;
        const keyword = record.keyword.trim();
        const shift = record.shift.trim();
        if (!keyword || !shift) return null;
        out.push({ keyword, shift });
    }
    return out.slice(0, 6);
}

export type NpcPatchOutcome = {
    npc: NPCEntry;
    applied: NpcAgentChange[];
    rejected: Array<{ change: NpcAgentChange; reason: string }>;
};

/** Apply validated changes to a copy of the record. Unknown or malformed changes are dropped. */
export function applyNpcAgentPatch(
    npc: NPCEntry,
    changes: readonly NpcAgentChange[],
    otherNames: readonly string[] = [],
): NpcPatchOutcome {
    const next: NPCEntry = {
        ...npc,
        wants: npc.wants ? { ...npc.wants } : undefined,
    };
    const applied: NpcAgentChange[] = [];
    const rejected: NpcPatchOutcome['rejected'] = [];

    for (const change of changes.slice(0, MAX_AGENT_CHANGES)) {
        const field = String(change.field ?? '');
        if (!(NPC_AGENT_FIELDS as readonly string[]).includes(field)) {
            rejected.push({ change, reason: `field "${field}" is not editable` });
            continue;
        }

        if (STRING_FIELDS.has(field)) {
            if (typeof change.to !== 'string') {
                rejected.push({ change, reason: 'expected a string' });
                continue;
            }
            const value = change.to.trim();
            if (!value) {
                rejected.push({ change, reason: 'refused to blank a field' });
                continue;
            }
            if (field === 'name') {
                const taken = otherNames.some(other => other.toLowerCase() === value.toLowerCase());
                if (taken) {
                    rejected.push({ change, reason: `name "${value}" already belongs to another NPC` });
                    continue;
                }
            }
            (next as Record<string, unknown>)[field] = value;
            applied.push({ ...change, to: value });
            continue;
        }

        if (ARRAY_FIELDS.has(field)) {
            const value = asStringArray(change.to, field === 'hardBoundaries' ? 5 : 5);
            if (!value) {
                rejected.push({ change, reason: 'expected an array of non-empty strings (max 5)' });
                continue;
            }
            (next as Record<string, unknown>)[field] = value;
            applied.push({ ...change, to: value });
            continue;
        }

        if (WANTS_ARRAY_FIELDS.has(field)) {
            const key = field.split('.')[1] as 'long' | 'medium' | 'short';
            if (key === 'long') {
                if (typeof change.to !== 'string' || !change.to.trim()) {
                    rejected.push({ change, reason: 'wants.long must be a non-empty string' });
                    continue;
                }
                next.wants = { ...(next.wants ?? { long: '', medium: [], short: [] }), long: change.to.trim() };
                applied.push({ ...change, to: change.to.trim() });
                continue;
            }
            const value = asStringArray(change.to, 3);
            if (!value) {
                rejected.push({ change, reason: 'expected an array of up to 3 strings' });
                continue;
            }
            next.wants = { ...(next.wants ?? { long: '', medium: [], short: [] }), [key]: value };
            applied.push({ ...change, to: value });
            continue;
        }

        if (TRIGGER_FIELDS.has(field)) {
            const value = asTriggers(change.to);
            if (!value) {
                rejected.push({ change, reason: 'expected an array of {"keyword","shift"}' });
                continue;
            }
            next.behavioralTriggers = value;
            applied.push({ ...change, to: value });
        }
    }

    return { npc: next, applied, rejected };
}

/** Parse a model answer into a patch. Returns null when the envelope is unusable. */
export function parseNpcAgentResponse(raw: string): NpcAgentResult | null {
    const parsed = extractJsonRobust<Record<string, unknown>>(raw, {});
    if (!parsed.parseOk || !parsed.value || typeof parsed.value !== 'object') return null;
    const value = parsed.value as Record<string, unknown>;
    const assessment = typeof value.assessment === 'string' ? value.assessment.trim() : '';
    const rawChanges = Array.isArray(value.changes) ? value.changes : [];
    const changes: NpcAgentChange[] = [];
    for (const item of rawChanges) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.field !== 'string') continue;
        changes.push({
            field: record.field,
            to: record.to,
            why: typeof record.why === 'string' ? record.why : undefined,
        });
    }
    const questions = Array.isArray(value.questions)
        ? value.questions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        : [];
    if (!assessment && changes.length === 0 && questions.length === 0) return null;
    return { assessment, changes, questions };
}

export async function runNpcAgent(opts: {
    npc: NPCEntry;
    otherNpcs: readonly NPCEntry[];
    place?: string;
    recentBeats?: readonly string[];
    instruction: string;
    provider: Parameters<typeof llmCall>[0];
}): Promise<NpcAgentResult> {
    const prompt = buildNpcAgentPrompt(opts);
    const raw = await llmCall(opts.provider, prompt, {
        maxTokens: 1_200,
        temperature: 0.3,
        trackingLabel: 'npc-agent',
        timeoutMs: AI_CALL_TIMEOUT_MS,
        priority: 'low',
    });
    const result = parseNpcAgentResponse(raw);
    if (!result) throw new Error('The NPC agent returned something unreadable. Try rephrasing the request.');
    return result;
}
