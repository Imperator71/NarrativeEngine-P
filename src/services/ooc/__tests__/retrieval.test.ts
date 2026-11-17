import { describe, expect, it } from 'vitest';
import { shouldSearchOoc } from '../retrieval';

describe('shouldSearchOoc', () => {
    it('pre-searches obvious record, lore, rule, and named-record questions', () => {
        expect(shouldSearchOoc('What happened earlier in the archive?')).toBe(true);
        expect(shouldSearchOoc('What do the rules say about resting?')).toBe(true);
        expect(shouldSearchOoc('What does Mira know?')).toBe(true);
    });

    it('consults records on every question, and still honours force-search', () => {
        expect(shouldSearchOoc('Can you summarize the current position?')).toBe(true);
        expect(shouldSearchOoc('Can you summarize the current position?', true)).toBe(true);
        expect(shouldSearchOoc('   ')).toBe(false);
    });
});