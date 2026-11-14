/**
 * The provider API keys live on the server now (data/settings.json, plaintext,
 * guarded by NAS volume permissions + Caddy auth). The browser never receives a
 * key: `GET /api/settings` returns this marker instead, so the settings UI can
 * show "a key is stored" without holding one.
 *
 * Must match `MASKED_KEY` in `server/routes/settings.js`.
 */
export const MASKED_KEY = '***';

export function isMaskedKey(value: string | null | undefined): boolean {
    return value === MASKED_KEY;
}

/** True when this string is a real secret the browser could actually use. */
export function hasRealKey(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.length > 0 && value !== MASKED_KEY;
}
