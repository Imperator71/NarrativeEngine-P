import { describe, expect, it, vi } from 'vitest';
import type { NPCEntry } from '../../../types';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));

const { applyNpcAgentPatch, parseNpcAgentResponse, buildNpcAgentPrompt } = await import('../npcAgent');

const npc = (patch: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'npc-1',
    name: 'Bram',
    aliases: '',
    appearance: 'Broad, grey-bearded, ink-stained cuffs.',
    faction: 'Tanners',
    storyRelevance: 'Runs the tannery.',
    status: 'alive',
    voice: 'Short sentences.',
    personality: 'Cautious.',
    exampleOutput: '',
    wants: { long: 'Keep the tannery solvent', medium: ['Settle the debt'], short: ['Close the shutters'] },
    ...patch,
});

describe('parseNpcAgentResponse', () => {
    it('reads the patch envelope', () => {
        const result = parseNpcAgentResponse('{"assessment":"Wants are stale.","changes":[{"field":"wants.short","to":["Count the coins at dawn"],"why":"the debt changed"}],"questions":[]}');
        expect(result).not.toBeNull();
        expect(result!.assessment).toBe('Wants are stale.');
        expect(result!.changes).toHaveLength(1);
        expect(result!.changes[0].field).toBe('wants.short');
    });

    it('rejects an answer with no assessment, changes, or questions', () => {
        expect(parseNpcAgentResponse('{"changes":[]}')).toBeNull();
        expect(parseNpcAgentResponse('not json at all')).toBeNull();
    });

    it('keeps questions when the instruction is ambiguous', () => {
        const result = parseNpcAgentResponse('{"assessment":"Ambiguous.","changes":[],"questions":["Which sibling — Mira or Cass?"]}');
        expect(result!.questions).toEqual(['Which sibling — Mira or Cass?']);
    });
});

describe('applyNpcAgentPatch', () => {
    it('applies authorial fields', () => {
        const outcome = applyNpcAgentPatch(npc(), [
            { field: 'personality', to: '  Cautious but proud.  ' },
            { field: 'appearance', to: 'Ninety years old, white-bearded.' },
        ]);
        expect(outcome.applied).toHaveLength(2);
        expect(outcome.npc.personality).toBe('Cautious but proud.');
        expect(outcome.npc.appearance).toContain('Ninety');
    });

    it('writes wants without dropping the other slices', () => {
        const outcome = applyNpcAgentPatch(npc(), [{ field: 'wants.short', to: ['Buy gold'] }]);
        expect(outcome.npc.wants?.short).toEqual(['Buy gold']);
        expect(outcome.npc.wants?.long).toBe('Keep the tannery solvent');
    });

    it('refuses engine and identity fields', () => {
        const outcome = applyNpcAgentPatch(npc(), [
            { field: 'id', to: 'hacked' },
            { field: 'isPC', to: true },
            { field: 'archived', to: true },
            { field: 'wants.short', to: ['Buy gold'] },
        ]);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.rejected).toHaveLength(3);
        expect(outcome.npc.id).toBe('npc-1');
    });

    it('refuses to blank a field or take a name another NPC uses', () => {
        const outcome = applyNpcAgentPatch(npc(), [
            { field: 'voice', to: '   ' },
            { field: 'name', to: 'Mira' },
        ], ['Mira']);
        expect(outcome.applied).toHaveLength(0);
        expect(outcome.rejected.map(r => r.reason).join(' ')).toContain('already belongs');
    });

    it('validates trigger arrays and boundary arrays', () => {
        const outcome = applyNpcAgentPatch(npc(), [
            { field: 'behavioralTriggers', to: [{ keyword: 'gold', shift: 'goes quiet and counts' }] },
            { field: 'hardBoundaries', to: ['never sells the tannery', 42] },
        ]);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.npc.behavioralTriggers?.[0].keyword).toBe('gold');
        expect(outcome.rejected).toHaveLength(1);
    });
});

describe('buildNpcAgentPrompt', () => {
    it('carries the record, the instruction, and the editable-field list', () => {
        const prompt = buildNpcAgentPrompt({
            npc: npc(),
            otherNpcs: [npc({ id: 'npc-2', name: 'Mira' })],
            instruction: 'Make them the elder brother of Mira and chase gold.',
        });
        expect(prompt).toContain('CURRENT RECORD');
        expect(prompt).toContain('Bram');
        expect(prompt).toContain('- Mira');
        expect(prompt).toContain('Make them the elder brother of Mira');
        expect(prompt).toContain('wants.short');
        // Age lives in prose: the prompt must not invite a numeric age field.
        expect(prompt).toContain('there is no numeric age field');
    });
});
