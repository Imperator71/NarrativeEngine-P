/**
 * Dice influence — the GM's hand on the engine's own rolls.
 *
 * The engine pre-rolls dice (world engines, the fairness pool, `roll_dice`
 * tool calls) and asserts the outcome to the model as FACT. That makes those
 * rolls deterministic once injected: the model must narrate what the engine
 * rolled. So the one honest place to steer them is here, before the assertion,
 * and the transcript must show the steered value — never the raw one.
 *
 * A state carries a mode and a value, plus how many rolls it may still touch:
 *
 *   min   — the roll is at least `value`      ("not below 12")
 *   max   — the roll is at most `value`       ("never a catastrophe")
 *   plus  — the roll is shifted by `value`    ("+3 on everything")
 *   exact — the roll is exactly `value`       ("the next one is a 20")
 *
 * `usesLeft: null` means the influence stays on until the GM turns it off;
 * a number means it burns one use per roll it touched.
 *
 * Values are clamped into the die's own range, so a `min 25` on a d20 becomes
 * 20 rather than an impossible 25.
 */

export type DiceInfluenceMode = 'min' | 'max' | 'plus' | 'exact';

export type DiceInfluence = {
    mode: DiceInfluenceMode;
    value: number;
    /** null = active until turned off; a number = rolls left to influence. */
    usesLeft: number | null;
};

export type DiceInfluenceResult = {
    value: number;
    /** True when the influence changed the raw roll (so the transcript can say so). */
    applied: boolean;
    /** One-line label for the player, e.g. "min 12". Empty when nothing applied. */
    label: string;
};

const clamp = (value: number, faces: number): number => Math.min(Math.max(value, 1), faces);

export function applyDiceInfluence(
    raw: number,
    faces: number,
    influence?: DiceInfluence | null,
): DiceInfluenceResult {
    if (!influence) return { value: raw, applied: false, label: '' };

    const wanted = Math.round(influence.value);
    let value = raw;
    switch (influence.mode) {
        case 'min': value = Math.max(raw, wanted); break;
        case 'max': value = Math.min(raw, wanted); break;
        case 'plus': value = raw + wanted; break;
        case 'exact': value = wanted; break;
    }
    value = clamp(value, faces);

    if (value === raw) return { value: raw, applied: false, label: '' };

    const sign = influence.mode === 'plus' && wanted > 0 ? '+' : '';
    const label = influence.mode === 'plus' ? `plus ${sign}${wanted}` : `${influence.mode} ${wanted}`;
    return { value, applied: true, label };
}

/**
 * Decrement the state after a roll it touched. Returns null when the influence
 * is spent, so callers can clear it from the context in one step.
 */
export function consumeDiceInfluence(influence: DiceInfluence): DiceInfluence | null {
    if (influence.usesLeft === null) return influence;      // stays until turned off
    if (influence.usesLeft <= 1) return null;                // this was the last one
    return { ...influence, usesLeft: influence.usesLeft - 1 };
}
