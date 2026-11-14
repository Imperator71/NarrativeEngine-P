import { Router } from 'express';
import { SETTINGS_FILE, readJson, writeJson } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * `data/settings.json` is now the home of the provider API keys.
 *
 * Upstream kept every key in the browser (encrypted with a device-local AES key
 * in IndexedDB) and blanked every `apiKey` before writing here, so a second
 * device never had a working provider. This fork moves the keys to the server:
 * they are written in plaintext and protected by the NAS volume permissions plus
 * the Caddy auth in front of the endpoint.
 *
 * The wire contract keeps the secret off the network:
 *   - GET returns `apiKey: "***"` for every stored key (present-but-hidden) and
 *     `""` where no key is stored.
 *   - PUT accepts `"***"` to mean "keep the key you already have". A client that
 *     never saw the secret can round-trip the whole settings object without
 *     destroying it; an empty string still clears the key.
 */

/** Marker returned instead of a stored key. */
export const MASKED_KEY = '***';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep clone with every `apiKey` replaced by the mask (or left empty). */
export function maskApiKeys(value) {
    if (Array.isArray(value)) return value.map(maskApiKeys);
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (key === 'apiKey' && typeof raw === 'string') out[key] = raw ? MASKED_KEY : '';
        else out[key] = maskApiKeys(raw);
    }
    return out;
}

/**
 * Merge an incoming payload onto the stored one, keeping stored secrets whose
 * incoming value is the mask. Walks both trees together, so any `apiKey` the
 * client did not really change keeps the value already on disk whatever the
 * settings shape is (providers[], legacy preset sections, future additions).
 */
export function mergeApiKeys(incoming, stored) {
    if (Array.isArray(incoming)) {
        const storedList = Array.isArray(stored) ? stored : [];
        return incoming.map((item, index) => mergeApiKeys(item, storedList[index]));
    }
    if (!isPlainObject(incoming)) return incoming;
    const out = {};
    for (const [key, raw] of Object.entries(incoming)) {
        if (key === 'apiKey' && typeof raw === 'string') {
            const previous = isPlainObject(stored) && typeof stored.apiKey === 'string' ? stored.apiKey : '';
            out[key] = raw === MASKED_KEY ? previous : raw;
            continue;
        }
        out[key] = mergeApiKeys(raw, isPlainObject(stored) ? stored[key] : undefined);
    }
    return out;
}

export function createSettingsRouter() {
    const router = Router();

    router.get('/api/settings', wrapAsync((_req, res) => {
        const settings = readJson(SETTINGS_FILE, {});
        res.json(maskApiKeys(settings));
    }));

    router.put('/api/settings', wrapAsync((req, res) => {
        const stored = readJson(SETTINGS_FILE, {});
        const merged = mergeApiKeys(req.body, stored);
        writeJson(SETTINGS_FILE, merged);
        // Echo the masked result so the client's in-memory copy never holds a
        // key it did not just type.
        res.json({ ok: true, ...maskApiKeys(merged) });
    }));

    return router;
}

/** Provider list as stored on disk — used by the LLM proxy to resolve keys. */
export function readProviders() {
    const settings = readJson(SETTINGS_FILE, {});
    const providers = settings && settings.settings ? settings.settings.providers : undefined;
    return Array.isArray(providers) ? providers : [];
}
