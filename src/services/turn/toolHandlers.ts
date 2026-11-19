import type { GameContext, LoreChunk, DiceSystemConfig, DieType, InventoryProposal } from '../../types';
import { searchLoreByQuery } from '../lore/loreRetriever';
import { uid } from '../../utils/uid';
import { mapTier } from '../engine/diceTier';
import { applyDiceInfluence } from '@narrative/engine';
import type { DiceInfluence } from '@narrative/engine';

// ── Constants ─────────────────────────────────────────────────────────
const MAX_NOTEBOOK_OPS = 5;
const MAX_NOTEBOOK_NOTES = 50;

// ── Types ─────────────────────────────────────────────────────────────

export type ToolContext = {
    loreChunks: LoreChunk[];
    notebook: GameContext['notebook'];
};

export type LoreHandlerResult = {
    toolResult: string;
};

export type NotebookHandlerResult = {
    toolResult: string;
    updatedNotebook: GameContext['notebook'];
};

export type DiceHandlerResult = {
    toolResult: string;
};

export type ProposeInventoryHandlerResult = {
    toolResult: string;
    proposal: InventoryProposal;
};

// ── Tool Definitions (JSON schemas for LLM tools array) ───────────────

const BASE_TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'query_campaign_lore',
            description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
            parameters: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const, description: 'The specific search query' } },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'update_scene_notebook',
            description: 'Update the scene notebook for tracking temporary state — timers, NPC positions, environmental conditions, combat state. Actions: add (create note), remove (delete by text match), clear (wipe all). Max 50 notes, max 5 actions per call. Use sparingly — only for volatile scene state that changes within a scene.',
            parameters: {
                type: 'object' as const,
                properties: {
                    actions: {
                        type: 'array' as const,
                        items: {
                            type: 'object' as const,
                            properties: {
                                op: { type: 'string' as const, enum: ['add', 'remove', 'clear'] },
                                text: { type: 'string' as const, description: 'Note text (ignored for clear op)' },
                            },
                            required: ['op'],
                        },
                        description: 'Array of notebook actions to perform (max 5)',
                        maxItems: 5,
                    },
                },
                required: ['actions'],
            },
        },
    },
] as const;

const ROLL_DICE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'roll_dice',
        description: `Roll dice ONLY when a check is genuinely in doubt AND failure would cost something concrete - injury, loss, time, exposure, or an NPC's lasting judgement. If the outcome is settled by the scene, the fiction, or the character's competence, do not call: narrate it.

Ordinary looking, listening, walking, haggling, or chatting is NOT a check. Perception and Social are the two most over-used categories - use Perception only for actively searching something hidden under pressure, and Social only when an NPC's reaction is truly contested and the stake is named in the fiction.

Call roll_dice BEFORE narrating the outcome, then shape the reply from the returned "tier".
   - "dice": die type for the category (Combat to d20, Social to d6, Perception to d6), as "NdM" with an optional modifier.
   - "reason": short label (e.g. "Stealth check vs guard").
   - "category": one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane.
Use the returned "tier" (Catastrophe / Failure / Success / Triumph / Narrative Boon) as the outcome. If no tier is returned, interpret the raw "result" per the campaign's Action Resolution rules.

Advantage: if the player explicitly leverages a known weakness or superior tool, call twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.

Outcome band semantics (when tier is returned):
- Catastrophe: severe unexpected failure, consequences beyond simple loss.
- Failure: fails. Damage, setback, or resource loss.
- Success: succeeds exactly as intended.
- Triumph: succeeds with an unexpected additional benefit.
- Narrative Boon: flawless. Massive strategic or narrative advantage.
Other custom bands: interpret per the campaign's Action Resolution rules.`,
        parameters: {
            type: 'object' as const,
            properties: {
                dice:     { type: 'string' as const, description: "Dice expression: '1d20', '2d6', '1d100', '1d4', optionally with '+N' or '-N' modifier. Use the die type matching the action's category." },
                reason:   { type: 'string' as const, description: "Short label, e.g. 'Stealth check vs guard' or 'Longsword attack'" },
                category: { type: 'string' as const, enum: ['Combat','Perception','Stealth','Social','Movement','Knowledge','Mundane'], description: 'Skill category for tier mapping (used for d20 only)' }
            },
            required: ['dice', 'reason']
        }
    }
} as const;

import { normalizeLocationTag } from '../../types';

const PROPOSE_INVENTORY_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_inventory_change',
        description:
            "Propose adding, removing, equipping, or relocating an item in the player's inventory when the fiction materially changes their gear (loot found, a weapon gifted/bought/broken, gear stashed at base or retrieved). This only *proposes* — the player must confirm before anything changes. Supply bounded labels ONLY; the engine sets all numbers (damage dice, bonus, AC). NEVER output damageDice, bonus, hp, or AC. Default quality to 'common'. Default location tag to 'inventory'.",
        parameters: {
            type: 'object' as const,
            properties: {
                name:            { type: 'string' as const, description: 'Item name.' },
                op:              { type: 'string' as const, enum: ['grant', 'remove', 'equip', 'relocate'], description: "Operation. Default 'grant'." },
                kind:            { type: 'string' as const, enum: ['weapon', 'armor', 'consumable', 'misc'], description: "Item kind. Default 'misc'." },
                quality:         { type: 'string' as const, enum: ['common', 'uncommon', 'rare', 'epic', 'legendary'], description: "Rarity/quality tier. Default 'common'." },
                scalingStat:     { type: 'string' as const, enum: ['PWR', 'SPD', 'WIL'], description: "Scaling stat for weapons. Default 'PWR'." },
                range:           { type: 'string' as const, enum: ['Close', 'Reach', 'Ranged'], description: "Weapon range. Default 'Close'." },
                properties:      { type: 'array' as const, items: { type: 'string' as const }, description: 'Flavor tags, e.g. ["fire","heavy"].' },
                equip:           { type: 'boolean' as const, description: 'Equip on confirm (weapons/armor). Default false.' },
                description:     { type: 'string' as const, description: 'Short flavor text.' },
                fromLocationTag: { type: 'string' as const, description: 'Source location tag for relocate op (e.g. "player base").' },
                locationTag:     { type: 'string' as const, description: 'Destination/target location tag (e.g. "inventory", "player base"). Default "inventory".' },
            },
            required: ['name'],
        },
    },
} as const;

export function getToolDefinitions(opts: { allowDiceTool: boolean }): unknown[] {
    const tools: unknown[] = [...BASE_TOOLS];
    if (opts.allowDiceTool) tools.push(ROLL_DICE_TOOL);
    // propose_inventory_change is combat-independent — always offered.
    tools.push(PROPOSE_INVENTORY_TOOL);
    return tools;
}

export const TOOL_DEFINITIONS = BASE_TOOLS;

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * Handles `query_campaign_lore` tool calls.
 * Returns the tool result string only — caller handles payload/message dispatch.
 */
export function handleLoreTool(
    toolArguments: string,
    ctx: ToolContext
): LoreHandlerResult {
    let query = '';
    try { query = JSON.parse(toolArguments).query || ''; } catch { /* Ignore */ }

    let toolResult = 'No relevant lore found.';
    if (query) {
        const found = searchLoreByQuery(ctx.loreChunks, query);
        if (found.length > 0) {
            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        }
    }

    return { toolResult };
}

/**
 * Handles `update_scene_notebook` tool calls.
 * Returns the tool result string and mutated notebook — caller handles payload/message dispatch.
 */
export function handleNotebookTool(
    toolArguments: string,
    ctx: ToolContext
): NotebookHandlerResult {
    let notebookActions: { op: string; text?: string }[] = [];
    try { notebookActions = JSON.parse(toolArguments).actions || []; } catch { /* Ignore */ }

    const currentNotebook = [...(ctx.notebook ?? [])];
    let opsCount = 0;

    for (const action of notebookActions) {
        if (opsCount >= MAX_NOTEBOOK_OPS) break;
        if (action.op === 'add' && action.text && currentNotebook.length < MAX_NOTEBOOK_NOTES) {
            currentNotebook.push({ id: uid(), text: action.text.trim(), timestamp: Date.now() });
        } else if (action.op === 'remove' && action.text) {
            const searchLower = action.text.toLowerCase().trim();
            const idx = currentNotebook.findIndex(n => n.text.toLowerCase().includes(searchLower));
            if (idx !== -1) currentNotebook.splice(idx, 1);
        } else if (action.op === 'clear') {
            currentNotebook.length = 0;
        }
        opsCount++;
    }

    const toolResult = `Notebook updated. ${currentNotebook.length} notes active.`;
    console.log(`[Notebook] Updated: ${currentNotebook.length} notes active (${opsCount} ops)`);

    return { toolResult, updatedNotebook: currentNotebook };
}

const VALID_OPS = new Set<string>(['grant', 'remove', 'equip', 'relocate']);
const VALID_KINDS = new Set<string>(['weapon', 'armor', 'consumable', 'misc']);
const VALID_QUALITIES = new Set<string>(['common', 'uncommon', 'rare', 'epic', 'legendary']);
const VALID_SCALING_STATS = new Set<string>(['PWR', 'SPD', 'WIL']);
const VALID_RANGES = new Set<string>(['Close', 'Reach', 'Ranged']);

/**
 * Handles `propose_inventory_change` tool calls. Pure parsing + clamping — no LLM
 * call, no mutation. Returns a normalized {@link InventoryProposal} for the caller
 * to stage for user confirmation (the player must confirm before the delta applies).
 * Numeric weapon/armor stats (damageDice, bonus, AC) are intentionally NOT parsed —
 * the engine (Phase 7) owns all numbers; the GM only supplies bounded labels.
 */
export function handleProposeInventoryTool(
    toolArguments: string
): ProposeInventoryHandlerResult {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Unknown Item';

    const rawOp = typeof args.op === 'string' ? args.op : '';
    const op: InventoryProposal['op'] = VALID_OPS.has(rawOp) ? (rawOp as InventoryProposal['op']) : 'grant';

    const rawKind = typeof args.kind === 'string' ? args.kind : '';
    const kind: InventoryProposal['kind'] = VALID_KINDS.has(rawKind) ? (rawKind as InventoryProposal['kind']) : 'misc';

    const rawQuality = typeof args.quality === 'string' ? args.quality : '';
    const quality: InventoryProposal['quality'] = VALID_QUALITIES.has(rawQuality) ? (rawQuality as InventoryProposal['quality']) : 'common';

    const rawScalingStat = typeof args.scalingStat === 'string' ? args.scalingStat : '';
    const scalingStat: InventoryProposal['scalingStat'] = VALID_SCALING_STATS.has(rawScalingStat) ? (rawScalingStat as InventoryProposal['scalingStat']) : 'PWR';

    const rawRange = typeof args.range === 'string' ? args.range : '';
    const range: InventoryProposal['range'] = VALID_RANGES.has(rawRange) ? (rawRange as InventoryProposal['range']) : 'Close';

    let properties: string[] = [];
    if (Array.isArray(args.properties)) {
        properties = args.properties.filter((p: unknown): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean);
    }

    const equip = typeof args.equip === 'boolean' ? args.equip : false;
    const description = typeof args.description === 'string' ? args.description : '';

    const fromLocationTag = typeof args.fromLocationTag === 'string' && args.fromLocationTag.trim()
        ? normalizeLocationTag(args.fromLocationTag)
        : undefined;

    const locationTag = typeof args.locationTag === 'string' && args.locationTag.trim()
        ? normalizeLocationTag(args.locationTag)
        : 'inventory';

    const proposal: InventoryProposal = {
        name, op, kind, quality, scalingStat, range, properties, equip, description,
        fromLocationTag, locationTag
    };

    return {
        toolResult: JSON.stringify({ status: 'staged', name, op, kind, quality, fromLocationTag, locationTag }),
        proposal,
    };
}

function parseAndRoll(expr: string): { total: number; breakdown: string; sides: number; count: number } {
    const match = expr.trim().toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
    if (!match) {
        // Fallback: d20 single roll (legacy default)
        const single = Math.floor(Math.random() * 20) + 1;
        return { total: single, breakdown: `${single}`, sides: 20, count: 1 };
    }
    const count = Math.min(parseInt(match[1], 10), 100);
    const sides = parseInt(match[2], 10);
    const modifier = match[3] ? parseInt(match[3], 10) : 0;
    const rolls: number[] = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const sum = rolls.reduce((a, b) => a + b, 0);
    const total = sum + modifier;
    const breakdown = modifier !== 0 ? `[${rolls.join('+')}]${modifier > 0 ? '+' : ''}${modifier} = ${total}` : `[${rolls.join('+')}] = ${total}`;
    return { total, breakdown, sides, count };
}

export function handleDiceTool(
    toolArguments: string,
    ctx: {
        diceSystem?: DiceSystemConfig | null;
        /** GM dice influence — applied to the total before the tier is mapped. */
        influence?: DiceInfluence | null;
    }
): DiceHandlerResult {
    let args: { dice?: string; reason?: string; category?: string } = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    const rolled = parseAndRoll(args.dice ?? '1d20');
    const influenced = applyDiceInfluence(rolled.total, rolled.sides, ctx.influence ?? null);
    const total = influenced.value;
    const breakdown = influenced.applied
        ? `${rolled.breakdown} → ${total} (${influenced.label})`
        : rolled.breakdown;
    const sides = rolled.sides;

    // Look up the DieType by face count for tier mapping
    let tier: string | null = null;
    if (ctx.diceSystem) {
        const dieType: DieType | undefined = ctx.diceSystem.dieTypes.find(d => d.faces === sides);
        if (dieType) tier = mapTier(total, dieType);
    }

    const payload: Record<string, unknown> = {
        dice: args.dice ?? '1d20',
        reason: args.reason ?? '',
        result: total,
        breakdown
    };
    if (tier) payload.tier = tier;

    return { toolResult: JSON.stringify(payload) };
}
