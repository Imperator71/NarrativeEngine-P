import { useSyncExternalStore } from 'react';
import { uid } from '../../utils/uid';
import { getTurnPhase, noteTurnCall, type TurnCallPhase, type TurnCallRole } from './turnLedger';

export type UtilityCallStatus = 'running' | 'success' | 'timeout' | 'error' | 'aborted';

export type UtilityCallRecord = {
    id: string;
    label: string;
    endpointName: string;
    startedAt: number;
    deadline: number;          // ms epoch — moves forward when extend() is called
    initialTimeoutMs: number;  // for "x / y" display
    extensions: number;        // how many times user pressed EXTEND
    status: UtilityCallStatus;
    settledAt?: number;
    durationMs?: number;
    errorMessage?: string;
    verbose?: Record<string, unknown>;
    sentRequests?: string[];
};

const MAX_HISTORY = 50;

/** Role + start phase per in-flight call, for the turn ledger. */
const callMeta = new Map<string, { role: TurnCallRole; phase: TurnCallPhase }>();

let active: UtilityCallRecord[] = [];
let history: UtilityCallRecord[] = [];
const listeners = new Set<() => void>();
const deadlineWaiters = new Map<string, Set<() => void>>();

function emit() {
    snapshotRef = { active, history };
    for (const l of listeners) l();
}

function notifyDeadline(id: string) {
    const waiters = deadlineWaiters.get(id);
    if (!waiters) return;
    for (const w of waiters) w();
}

export type UtilityCallHandle = {
    id: string;
    recordRequestBody: (body: string) => void;
    /** Resolves when the deadline elapses without an extension. Re-armed by extend(). Never rejects. */
    deadlinePromise: Promise<void>;
    /** Push the deadline forward by ms (default 60000). No-op if already settled. */
    extend: (ms?: number) => void;
    /** Reset the deadline to now + ms (for streaming calls with a rolling idle timeout). No-op if settled. */
    resetDeadline: (ms: number) => void;
    /** Mark success. Records duration + moves to history. */
    settleSuccess: (verbose?: Record<string, unknown>) => void;
    /** Mark failure (error or timeout). */
    settleError: (status: 'timeout' | 'error' | 'aborted', message?: string) => void;
};

export function startUtilityCall(
    label: string,
    endpointName: string,
    timeoutMs: number,
    role: TurnCallRole = 'unknown',
): UtilityCallHandle {
    const id = uid();
    const now = Date.now();
    // The phase is captured at start, not at settle: a call that begins before the
    // narration is critical even if it finishes after it.
    const phase: TurnCallPhase = getTurnPhase();
    callMeta.set(id, { role, phase });
    const record: UtilityCallRecord = {
        id,
        label,
        endpointName,
        startedAt: now,
        deadline: now + timeoutMs,
        initialTimeoutMs: timeoutMs,
        extensions: 0,
        status: 'running',
    };
    active = [...active, record];
    emit();

    const waitForDeadline = (): Promise<void> => new Promise<void>(resolve => {
        const cur = active.find(c => c.id === id);
        if (!cur) { resolve(); return; }
        const remaining = cur.deadline - Date.now();
        if (remaining <= 0) { resolve(); return; }

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const set = deadlineWaiters.get(id);
            if (set) set.delete(finish);
            resolve();
        };
        const timer = setTimeout(finish, remaining);
        const waiters = deadlineWaiters.get(id) ?? new Set<() => void>();
        waiters.add(finish);
        deadlineWaiters.set(id, waiters);
    });

    // Chain: every time we resolve, re-check if deadline moved; if so, wait again. Only resolve to caller when truly elapsed.
    const deadlinePromise: Promise<void> = (async () => {
         
        while (true) {
            await waitForDeadline();
            const cur = active.find(c => c.id === id);
            if (!cur) return; // settled externally
            if (cur.deadline <= Date.now()) return; // truly expired
            // else: deadline moved forward — loop
        }
    })();

    const handle: UtilityCallHandle = {
        id,
        deadlinePromise,
        recordRequestBody(body) {
            const call = active.find(c => c.id === id);
            if (!call) return;
            const updated = { ...call, sentRequests: [...(call.sentRequests ?? []), body] };
            active = active.map(c => c.id === id ? updated : c);
            emit();
        },
        extend(ms = 60000) {
            const idx = active.findIndex(c => c.id === id);
            if (idx === -1) return;
            const cur = active[idx];
            if (cur.status !== 'running') return;
            const updated: UtilityCallRecord = {
                ...cur,
                deadline: cur.deadline + ms,
                extensions: cur.extensions + 1,
            };
            active = active.map(c => (c.id === id ? updated : c));
            emit();
            notifyDeadline(id);
        },
        resetDeadline(ms) {
            const idx = active.findIndex(c => c.id === id);
            if (idx === -1) return;
            const cur = active[idx];
            if (cur.status !== 'running') return;
            const now = Date.now();
            const updated: UtilityCallRecord = {
                ...cur,
                deadline: now + ms,
            };
            active = active.map(c => (c.id === id ? updated : c));
            emit();
            notifyDeadline(id);
        },
        settleSuccess(verbose) {
            settle(id, 'success', undefined, verbose);
        },
        settleError(status, message) {
            settle(id, status, message);
        },
    };

    return handle;
}

function settle(
    id: string,
    status: UtilityCallStatus,
    errorMessage?: string,
    verbose?: Record<string, unknown>,
) {
    const idx = active.findIndex(c => c.id === id);
    if (idx === -1) return;
    const cur = active[idx];
    const settledAt = Date.now();
    const finalRecord: UtilityCallRecord = {
        ...cur,
        status,
        settledAt,
        durationMs: settledAt - cur.startedAt,
        errorMessage,
        verbose: verbose ?? cur.verbose,
    };
    active = active.filter(c => c.id !== id);
    history = [finalRecord, ...history].slice(0, MAX_HISTORY);

    // Turn ledger: this is the one place every model call settles, so it is the only
    // place that has to report. A missing meta entry means the call predates the turn.
    const meta = callMeta.get(id);
    callMeta.delete(id);
    if (meta) {
        noteTurnCall({
            label: cur.label,
            role: meta.role,
            phase: meta.phase,
            endpointName: cur.endpointName,
            startedAt: cur.startedAt,
            durationMs: finalRecord.durationMs ?? 0,
            status: status === 'running' ? 'error' : status,
        });
    }

    // Wake any waiters so deadlinePromise loop exits via the "settled externally" branch
    notifyDeadline(id);
    deadlineWaiters.delete(id);
    emit();
}

export function getActiveCalls(): UtilityCallRecord[] {
    return active;
}

export function getCallHistory(): UtilityCallRecord[] {
    return history;
}

export function extendCall(id: string, ms = 60000) {
    const cur = active.find(c => c.id === id);
    if (!cur) return;
    const updated = { ...cur, deadline: cur.deadline + ms, extensions: cur.extensions + 1 };
    active = active.map(c => (c.id === id ? updated : c));
    emit();
    notifyDeadline(id);
}

export function clearHistory() {
    history = [];
    emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useUtilityCalls(): {
    active: UtilityCallRecord[];
    history: UtilityCallRecord[];
} {
    const snap = useSyncExternalStore(
        subscribe,
        () => snapshotRef,
        () => snapshotRef,
    );
    return snap;
}

// Keep a stable snapshot so useSyncExternalStore doesn't loop on referential equality.
let snapshotRef: { active: UtilityCallRecord[]; history: UtilityCallRecord[] } = {
    active,
    history,
};
