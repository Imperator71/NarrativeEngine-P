import { describe, it, expect } from 'vitest';
import { applyDiceInfluence, consumeDiceInfluence } from '../diceInfluence';
import type { DiceInfluence } from '../diceInfluence';

/**
 * The influence sits between the raw die and the fact asserted to the model,
 * so these tests pin the two things that matter: the value the GM asked for,
 * and that a roll outside the influence is left exactly as it fell.
 */

const influence = (mode: DiceInfluence['mode'], value: number, usesLeft: number | null = null): DiceInfluence =>
    ({ mode, value, usesLeft });

describe('applyDiceInfluence — modes', () => {
    it('min lifts a low roll to the floor and leaves a high roll alone', () => {
        expect(applyDiceInfluence(4, 20, influence('min', 12)).value).toBe(12);
        const untouched = applyDiceInfluence(17, 20, influence('min', 12));
        expect(untouched.value).toBe(17);
        expect(untouched.applied).toBe(false);
    });

    it('max drops a high roll to the ceiling and leaves a low roll alone', () => {
        expect(applyDiceInfluence(19, 20, influence('max', 15)).value).toBe(15);
        expect(applyDiceInfluence(3, 20, influence('max', 15)).applied).toBe(false);
    });

    it('plus shifts the roll, and a negative value shifts it down', () => {
        expect(applyDiceInfluence(10, 20, influence('plus', 3)).value).toBe(13);
        expect(applyDiceInfluence(10, 20, influence('plus', -4)).value).toBe(6);
    });

    it('exact replaces the roll outright', () => {
        expect(applyDiceInfluence(2, 20, influence('exact', 20)).value).toBe(20);
    });

    it('clamps into the die’s own range — a min 25 on a d20 is 20, not 25', () => {
        expect(applyDiceInfluence(4, 20, influence('min', 25)).value).toBe(20);
        expect(applyDiceInfluence(4, 6, influence('exact', 0)).value).toBe(1);
        expect(applyDiceInfluence(18, 20, influence('plus', 9)).value).toBe(20);
    });

    it('does nothing without an influence', () => {
        const r = applyDiceInfluence(7, 20, null);
        expect(r).toEqual({ value: 7, applied: false, label: '' });
    });

    it('flags when it applied, and labels the mode for the transcript', () => {
        const r = applyDiceInfluence(4, 20, influence('min', 12));
        expect(r.applied).toBe(true);
        expect(r.label).toBe('min 12');
        expect(applyDiceInfluence(10, 20, influence('plus', 3)).label).toBe('plus +3');
    });
});

describe('consumeDiceInfluence — duration', () => {
    it('keeps an until-off influence forever', () => {
        const s = influence('min', 12, null);
        expect(consumeDiceInfluence(s)).toEqual(s);
    });

    it('burns one use per turn and clears when spent', () => {
        expect(consumeDiceInfluence(influence('min', 12, 3))?.usesLeft).toBe(2);
        expect(consumeDiceInfluence(influence('min', 12, 1))).toBeNull();
    });
});
