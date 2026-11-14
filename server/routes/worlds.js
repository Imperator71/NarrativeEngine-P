import { Router } from 'express';
import { WORLDS_FILE, readJson, writeJson, ensureDirs } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * World lore drafts — server-side.
 *
 * Upstream kept these in `localStorage` under `nn_world_lore_drafts` (one JSON
 * blob, ~73 KB for a single built world). That made authored world content
 * invisible to every other device: open the app on a tablet and the builder
 * says "No draft selected", even though the campaign built from that world
 * loads fine. Drafts are user content, so they live next to the campaigns.
 *
 * The whole list is written at once because that is how the client's Zustand
 * slice already behaves — one array, one debounced save. Splitting into
 * per-draft files would buy nothing and complicate ordering.
 */

function sanitiseDrafts(value) {
    if (!Array.isArray(value)) return null;
    const drafts = [];
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        if (!id) continue;
        drafts.push({ ...raw, id, name: typeof raw.name === 'string' ? raw.name : 'Untitled World' });
    }
    return drafts;
}

export function createWorldsRouter() {
    const router = Router();

    router.get('/api/worlds', wrapAsync((_req, res) => {
        ensureDirs();
        const stored = readJson(WORLDS_FILE, { drafts: [] });
        const drafts = sanitiseDrafts(stored && stored.drafts) || [];
        res.json({ drafts });
    }));

    router.put('/api/worlds', wrapAsync((req, res) => {
        ensureDirs();
        const drafts = sanitiseDrafts(req.body && req.body.drafts);
        if (!drafts) {
            res.status(400).json({ error: 'Body must be { drafts: [...] }' });
            return;
        }
        writeJson(WORLDS_FILE, { drafts });
        res.json({ ok: true, count: drafts.length });
    }));

    return router;
}
