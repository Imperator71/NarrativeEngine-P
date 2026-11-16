// ─── Turn ledger ──────────────────────────────────────────────────────────────
// What one player turn actually costs, in requests.
//
// Why this exists: a turn fires between two and ten model calls (recall picker,
// recommender, NPC stances, director brief, the narration, then stakes, location,
// NPC validation/update, relationship memory and chapter sealing). Until now the
// only way to know which of them actually fired was to read the source and guess
// at the settings. The play-test argument ("too many requests") could not be
// settled with a number, and neither could a fix be shown to help.
//
// Every call already passes through `startUtilityCall` (the narration included),
// so that is the one place that has to report. Each record carries the phase it
// started in:
//
//   critical — the player is waiting for the reply and cannot proceed without it
//   idle     — housekeeping that could have happened while the player was reading
//
// The split is the point. The total tells you what you pay; the critical count
// tells you what the turn *feels* like. A pipeline that moves work from critical
// to idle makes the game feel faster without spending fewer tokens.

export type TurnCallPhase = 'critical' | 'idle';
export type TurnCallRole = 'story' | 'utility' | 'auxiliary' | 'vision' | 'unknown';

export type TurnCallRecord = {
    label: string;
    role: TurnCallRole;
    phase: TurnCallPhase;
    endpointName: string;
    startedAt: number;
    durationMs: number;
    status: 'success' | 'timeout' | 'error' | 'aborted';
};

export type TurnLedger = {
    turnId: string;
    campaignId: string | null;
    tier: string | null;
    startedAt: number;
    calls: TurnCallRecord[];
};

export type TurnLedgerSummary = {
    turnId: string;
    total: number;
    critical: number;
    idle: number;
    failed: number;
    criticalMs: number;
    idleMs: number;
    byLabel: Record<string, number>;
};

let currentTurn: TurnLedger | null = null;
let lastTurn: TurnLedger | null = null;
let phase: TurnCallPhase = 'critical';
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** Start a new ledger. Called once per turn, before any stage runs. */
export function beginTurnLedger(turnId: string, campaignId: string | null, tier?: string | null): void {
    if (currentTurn) lastTurn = currentTurn;
    currentTurn = {
        turnId,
        campaignId: campaignId ?? null,
        tier: tier ?? null,
        startedAt: Date.now(),
        calls: [],
    };
    phase = 'critical';
    emit();
}

/**
 * Set the phase that subsequent calls are filed under. The orchestrator flips to
 * `idle` once the narration is under way; the commit path sets it explicitly so a
 * commit that runs before generation has settled cannot mislabel its calls.
 */
export function setTurnPhase(next: TurnCallPhase): void {
    phase = next;
}

export function getTurnPhase(): TurnCallPhase {
    return phase;
}

/** Record one settled model call against the current turn. No-op without a turn. */
export function noteTurnCall(call: TurnCallRecord): void {
    if (!currentTurn) return;
    // Replace rather than push: the ledger is a React snapshot, and mutating the array
    // in place would leave useSyncExternalStore looking at the same reference.
    currentTurn = { ...currentTurn, calls: [...currentTurn.calls, call] };
    emit();
}

export function getCurrentTurnLedger(): TurnLedger | null {
    return currentTurn;
}

export function getLastTurnLedger(): TurnLedger | null {
    return lastTurn;
}

/** Whichever ledger the debug panel should show: the live turn, else the last one. */
export function getLedgerSnapshot(): TurnLedger | null {
    return currentTurn ?? lastTurn;
}

/** Counts and wall time, split by phase. The number the pipeline work is judged by. */
export function summarizeTurn(ledger: TurnLedger | null): TurnLedgerSummary | null {
    if (!ledger) return null;
    const summary: TurnLedgerSummary = {
        turnId: ledger.turnId,
        total: ledger.calls.length,
        critical: 0,
        idle: 0,
        failed: 0,
        criticalMs: 0,
        idleMs: 0,
        byLabel: {},
    };
    for (const call of ledger.calls) {
        summary.byLabel[call.label] = (summary.byLabel[call.label] ?? 0) + 1;
        if (call.phase === 'critical') {
            summary.critical += 1;
            summary.criticalMs += call.durationMs;
        } else {
            summary.idle += 1;
            summary.idleMs += call.durationMs;
        }
        if (call.status !== 'success') summary.failed += 1;
    }
    return summary;
}

/** One-line log line, for the debug console at the end of a turn. */
export function formatTurnSummary(summary: TurnLedgerSummary): string {
    const labels = Object.entries(summary.byLabel)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => `${label}×${count}`)
        .join(', ');
    return `[TurnLedger] ${summary.total} model calls — ${summary.critical} critical `
        + `(${(summary.criticalMs / 1000).toFixed(1)}s), ${summary.idle} idle `
        + `(${(summary.idleMs / 1000).toFixed(1)}s)${summary.failed ? `, ${summary.failed} failed` : ''}`
        + (labels ? ` — ${labels}` : '');
}

export function subscribeTurnLedger(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test seam: forget both ledgers. */
export function resetTurnLedger(): void {
    currentTurn = null;
    lastTurn = null;
    phase = 'critical';
    emit();
}
