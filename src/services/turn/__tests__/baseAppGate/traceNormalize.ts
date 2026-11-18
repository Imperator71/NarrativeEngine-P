/**
 * Trace stabilization for the base-app gates.
 *
 * The gate compares a whole canonical turn byte-for-byte, which is what makes it
 * worth having. But part of that trace is *generated*: message ids come from
 * `uid()` (clock + random, both stubbed but still monotonic) and timestamps come
 * from the fake clock. Both advance once per call, so a change anywhere earlier
 * in the turn — one extra utility call, one extra clock read — shifts every id
 * and timestamp after it and fails the gate on values that carry no behavior.
 *
 * That is noise, not signal: the failure says "call ordering changed", while the
 * gate's job is "the payload or the effect order changed". So ids and timestamps
 * are mapped to stable symbols in first-appearance order. Identity survives (the
 * same id always maps to the same symbol, distinct ids stay distinct), and every
 * other byte — prompt text, arguments, effect names, order — is still compared
 * exactly.
 */

const ID_KEY = /(^id$|Id$|_id$|^ids$|Ids$)/;
const TIME_KEY = /^(timestamp|startedAt|settledAt|deadline|createdAt|updatedAt)$/;

export function stabilizeTrace(trace: unknown): unknown {
    const ids = new Map<string, string>();
    const times = new Map<number, string>();

    const walk = (value: unknown, key: string | null): unknown => {
        if (Array.isArray(value)) return value.map(item => walk(item, null));
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
                out[childKey] = walk(childValue, childKey);
            }
            return out;
        }
        if (typeof value === 'string' && key && ID_KEY.test(key)) {
            let symbol = ids.get(value);
            if (!symbol) {
                symbol = `<id:${ids.size + 1}>`;
                ids.set(value, symbol);
            }
            return symbol;
        }
        if (typeof value === 'number' && key && TIME_KEY.test(key)) {
            let symbol = times.get(value);
            if (!symbol) {
                symbol = `<t:${times.size + 1}>`;
                times.set(value, symbol);
            }
            return symbol;
        }
        return value;
    };

    return walk(trace, null);
}

export function serializeStableTrace(trace: unknown): string {
    return JSON.stringify(stabilizeTrace(trace), null, 0);
}
