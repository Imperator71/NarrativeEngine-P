import { describe, it, expect, beforeEach } from 'vitest';
import {
    beginTurnLedger,
    setTurnPhase,
    getTurnPhase,
    noteTurnCall,
    getCurrentTurnLedger,
    getLastTurnLedger,
    summarizeTurn,
    formatTurnSummary,
    resetTurnLedger,
    type TurnCallRecord,
} from '../turnLedger';

/**
 * The scoreboard for the turn pipeline. A turn fires between two and ten model
 * calls; what matters for how the game *feels* is how many of them the player
 * waits on, so the split is the point and the total is the context.
 */

function call(overrides: Partial<TurnCallRecord> = {}): TurnCallRecord {
    return {
        label: 'npc-stance',
        role: 'utility',
        phase: 'critical',
        endpointName: 'strata',
        startedAt: 1_000,
        durationMs: 500,
        status: 'success',
        ...overrides,
    };
}

beforeEach(() => {
    resetTurnLedger();
});

describe('turn ledger', () => {
    it('files calls against the open turn and counts them by phase', () => {
        beginTurnLedger('turn-1', 'campaign-a', 'pro');
        noteTurnCall(call({ label: 'planner' }));
        noteTurnCall(call({ label: 'story', role: 'story', durationMs: 4_000 }));

        setTurnPhase('idle');
        noteTurnCall(call({ label: 'scene-stakes', phase: 'idle', durationMs: 700 }));
        noteTurnCall(call({ label: 'location-enrich', phase: 'idle', durationMs: 300 }));

        const summary = summarizeTurn(getCurrentTurnLedger())!;
        expect(summary.total).toBe(4);
        expect(summary.critical).toBe(2);
        expect(summary.idle).toBe(2);
        expect(summary.criticalMs).toBe(4_500);
        expect(summary.idleMs).toBe(1_000);
        expect(summary.byLabel.story).toBe(1);
    });

    it('captures the phase at call start, so a critical call that finishes during idle stays critical', () => {
        beginTurnLedger('turn-2', 'campaign-a');
        const startedAt = Date.now();
        setTurnPhase('idle'); // the phase moves while the call is still in flight
        noteTurnCall(call({ phase: 'critical', startedAt }));

        const summary = summarizeTurn(getCurrentTurnLedger())!;
        expect(summary.critical).toBe(1);
        expect(summary.idle).toBe(0);
    });

    it('counts every non-success status as failed', () => {
        beginTurnLedger('turn-3', 'campaign-a');
        noteTurnCall(call({ status: 'success' }));
        noteTurnCall(call({ status: 'timeout' }));
        noteTurnCall(call({ status: 'aborted' }));

        expect(summarizeTurn(getCurrentTurnLedger())!.failed).toBe(2);
    });

    it('keeps the previous turn when a new one opens, and ignores calls with no turn open', () => {
        noteTurnCall(call()); // no turn yet — dropped, not counted anywhere
        beginTurnLedger('turn-4', 'campaign-a');
        noteTurnCall(call());
        beginTurnLedger('turn-5', 'campaign-a');

        expect(getLastTurnLedger()!.turnId).toBe('turn-4');
        expect(getLastTurnLedger()!.calls).toHaveLength(1);
        expect(getCurrentTurnLedger()!.turnId).toBe('turn-5');
        expect(getCurrentTurnLedger()!.calls).toHaveLength(0);
    });

    it('opens every turn in the critical phase', () => {
        beginTurnLedger('turn-6', 'campaign-a');
        setTurnPhase('idle');
        beginTurnLedger('turn-7', 'campaign-a');
        expect(getTurnPhase()).toBe('critical');
    });

    it('the log line names the split and the busiest labels', () => {
        beginTurnLedger('turn-8', 'campaign-a');
        noteTurnCall(call({ label: 'planner', durationMs: 1_200 }));
        noteTurnCall(call({ label: 'npc-stance', durationMs: 800 }));
        setTurnPhase('idle');
        noteTurnCall(call({ label: 'scene-stakes', phase: 'idle', durationMs: 400 }));

        const line = formatTurnSummary(summarizeTurn(getCurrentTurnLedger())!);
        expect(line).toContain('3 model calls');
        expect(line).toContain('2 critical');
        expect(line).toContain('1 idle');
        expect(line).toContain('planner×1');
    });
});
