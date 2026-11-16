import type { SceneStakes, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { recordSceneStakesFallback } from './sceneStakesTelemetry';
import { ENGINE_CALL_TIMEOUT_MS } from '../llm/timeouts';

// Phase 2 port: mobile used a shared infrastructure/utilityPrompts module for these constant
// sections; desktop has no equivalent shared module. Inlined here (small + only used by this
// helper) — a future refactor can lift them to a shared utilityPrompts module if more callers
// need them.
const TTRPG_PERSONA_STATE_ANALYZER = 'You are a background game state analyzer.';
const JSON_ONLY_FOOTER = 'Respond with ONE JSON object only. No prose, no markdown fences.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const INPUT_DELIMITER = '----- INPUT -----';

function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections.filter(Boolean).join('\n\n');
}

const SCENE_STAKES_RE = /\[\[SCENE_STAKES:\s*(calm|tense|dangerous)\s*\]\]/i;
const SCENE_STAKES_ANY_RE = /\[\[SCENE_STAKES:\s*\S+\s*\]\]/i;
const VALID_STAKES: Set<string> = new Set(['calm', 'tense', 'dangerous']);

/**
 * How much of the scene the classifier may read.
 *
 * These were 500 per message / 1000 pending / 3000 total. At 500 chars the model
 * often saw only the first sentence of a GM message — the stage direction, not the
 * action that decides the stakes — cut mid-word. The classifier is a 20-token call
 * on the utility slot, so a wider window costs almost nothing and removes the
 * guesswork. Raised to 4000/4000/24000 (roughly 6k tokens of context for a local
 * model, trivial for a 250k-context one).
 */
export const SCENE_STAKES_PER_MESSAGE_CHARS = 4_000;
export const SCENE_STAKES_PENDING_CHARS = 4_000;
export const SCENE_STAKES_TOTAL_CHARS = 24_000;

/**
 * Keep the END of the text, never half a word.
 *
 * Stakes are decided by the latest beat, so the tail matters more than the
 * opening. The leading fragment left by the cut is dropped at the first
 * whitespace so the model never reads a chopped word as content.
 */
export function clipSceneText(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text;
    const tail = text.slice(text.length - maxChars);
    const breakIndex = tail.slice(0, 120).search(/\s/);
    return breakIndex > 0 ? tail.slice(breakIndex + 1) : tail;
}

type SceneMessage = { role: string; content?: string | null };

/**
 * Assemble the classifier's VIEW of the scene: the last three messages plus the
 * pending turn. The pending turn is usually already the last message, so it is
 * only appended when it is genuinely new — this used to send the same GM text
 * twice, once clipped at 500 and again at 1000.
 */
export function buildSceneStakesInput(
    messages: ReadonlyArray<SceneMessage>,
    pendingText: string,
): string {
    const recent = messages.slice(-3).map(message => {
        const role = message.role === 'assistant' ? 'GM' : message.role.toUpperCase();
        return `[${role}]: ${clipSceneText(message.content || '', SCENE_STAKES_PER_MESSAGE_CHARS)}`;
    });
    const pending = clipSceneText(pendingText || '', SCENE_STAKES_PENDING_CHARS);
    const last = messages[messages.length - 1];
    const probe = pending.slice(0, 200).trim();
    const alreadyPresent = Boolean(probe) && Boolean(last?.content?.includes(probe));
    return (alreadyPresent ? recent : [...recent, pending])
        .filter(section => section && section.trim())
        .join('\n\n');
}

export function extractAndStripSceneStakes(text: string): { displayText: string; stakes: SceneStakes } {
    const match = text.match(SCENE_STAKES_RE);
    if (!match) {
        const garbled = text.match(SCENE_STAKES_ANY_RE);
        if (garbled) {
            const displayText = text.replace(SCENE_STAKES_ANY_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            return { displayText, stakes: 'calm' };
        }
        return { displayText: text, stakes: 'calm' };
    }
    const raw = match[1].toLowerCase();
    const stakes: SceneStakes = VALID_STAKES.has(raw) ? (raw as SceneStakes) : 'calm';
    const displayText = text.replace(SCENE_STAKES_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { displayText, stakes };
}

export async function classifySceneStakes(
    provider: EndpointConfig | ProviderConfig | undefined,
    recentScene: string,
    modelCall?: (prompt: string, options: {
        priority: 'low';
        maxTokens: number;
        thinkingEffort: 'off';
        trackingLabel: string;
        timeoutMs: number;
    }) => Promise<string>,
): Promise<SceneStakes> {
    const prompt = joinPromptSections(
        TTRPG_PERSONA_STATE_ANALYZER,
        'TASK: Classify the scene stakes as one of: calm, tense, dangerous.\n' +
        'calm = no immediate threat; tense = physical OR social/political threat looming;\n' +
        'dangerous = active harm or imminent deadly/ruinous consequences.',
        JSON_ONLY_FOOTER,
        'Output ONLY: {"stakes":"calm"} or {"stakes":"tense"} or {"stakes":"dangerous"}',
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
        clipSceneText(recentScene, SCENE_STAKES_TOTAL_CHARS),
    );

    recordSceneStakesFallback();

    try {
        const raw = modelCall
            ? await modelCall(prompt, { priority: 'low', maxTokens: 20, thinkingEffort: 'off', trackingLabel: 'scene-stakes-classify', timeoutMs: ENGINE_CALL_TIMEOUT_MS })
            : provider
                ? await llmCall(provider, prompt, {
                    priority: 'low',
                    maxTokens: 20,
                    thinkingEffort: 'off',
                    trackingLabel: 'scene-stakes-classify',
                    timeoutMs: ENGINE_CALL_TIMEOUT_MS,
                })
                : null;
        if (raw === null) return 'calm';
        const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        const parsed = JSON.parse(cleaned);
        const s = String(parsed.stakes ?? '').toLowerCase();
        if (VALID_STAKES.has(s)) return s as SceneStakes;
    } catch { /* malformed → calm */ }
    return 'calm';
}