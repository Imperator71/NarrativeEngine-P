import { describe, it, expect } from 'vitest';
import {
    buildSceneStakesInput,
    clipSceneText,
    SCENE_STAKES_PER_MESSAGE_CHARS,
    SCENE_STAKES_PENDING_CHARS,
    SCENE_STAKES_TOTAL_CHARS,
} from '../sceneStakesTag';

/**
 * The classifier used to read 500 chars per message, cut mid-word, and receive
 * the pending turn twice. These pin the widened budgets and the two repairs.
 */
describe('scene stakes input window', () => {
    it('allows far more than the old 500-char fragment per message', () => {
        expect(SCENE_STAKES_PER_MESSAGE_CHARS).toBeGreaterThanOrEqual(4_000);
        expect(SCENE_STAKES_PENDING_CHARS).toBeGreaterThanOrEqual(4_000);
        expect(SCENE_STAKES_TOTAL_CHARS).toBeGreaterThanOrEqual(24_000);
    });

    it('keeps a full GM paragraph that the old 500-char cut would have severed', () => {
        const paragraph = `${'The rain had stopped. '.repeat(60)}She took one precise step back.`;
        const input = buildSceneStakesInput([{ role: 'assistant', content: paragraph }], '');
        expect(input).toContain('She took one precise step back.');
        expect(input.length).toBeGreaterThan(1_000);
    });

    it('never cuts mid-word', () => {
        const text = 'alpha bravo charlie delta echo foxtrot golf hotel';
        const clipped = clipSceneText(text, 20);
        expect(clipped.startsWith(' ')).toBe(false);
        expect(text.includes(clipped.trim())).toBe(true);
        // The first word of the kept tail is whole.
        expect(clipped.trim().split(' ')[0]).toMatch(/^(charlie|delta|echo|foxtrot|golf|hotel|bravo)$/);
    });

    it('keeps the tail, because stakes are decided by the latest beat', () => {
        const text = `OPENING_MARKER ${'calm filler '.repeat(500)}DANGEROUS: the blade is at her throat.`;
        const clipped = clipSceneText(text, 200);
        expect(clipped).toContain('DANGEROUS: the blade is at her throat.');
        expect(clipped.length).toBeLessThanOrEqual(200);
        // The opening of the message is gone: this is the end of the scene, not the start.
        expect(clipped).not.toContain('OPENING_MARKER');
    });

    it('sends the pending turn once when it is already the last message', () => {
        const pending = 'She cut you off cleanly. "Don\'t."';
        const input = buildSceneStakesInput([
            { role: 'user', content: 'A brat remark.' },
            { role: 'assistant', content: pending },
        ], pending);
        expect(input.split('She cut you off cleanly').length - 1).toBe(1);
    });

    it('still includes the pending turn when the last message does not contain it', () => {
        const input = buildSceneStakesInput(
            [{ role: 'user', content: 'A brat remark.' }],
            'The GM answer that is not stored yet.',
        );
        expect(input).toContain('The GM answer that is not stored yet.');
        expect(input).toContain('[USER]: A brat remark.');
    });

    it('labels roles and keeps the last three messages only', () => {
        const input = buildSceneStakesInput([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
            { role: 'user', content: 'third' },
            { role: 'assistant', content: 'fourth' },
        ], '');
        expect(input).not.toContain('first');
        expect(input).toContain('[GM]: second');
        expect(input).toContain('[USER]: third');
        expect(input).toContain('[GM]: fourth');
    });
});
