// PUT /api/settings — the server owns provider keys; the browser only sees a mask.
//
// Upstream's contract was the opposite: blank every apiKey before it reached
// disk, so a second device never had a working provider. Pins here:
//   1. a real key in the payload is written to data/settings.json (plaintext by
//      design — NAS volume perms + Caddy auth are the boundary),
//   2. GET never returns it, it returns the "***" marker instead,
//   3. PUT of "***" keeps whatever is stored, so a client that never saw the
//      secret cannot destroy it by round-tripping the settings object,
//   4. an empty string still clears the key.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

let tmpDir;
let originalDataDir;
let request;
let settingsFile;
let maskApiKeys;
let mergeApiKeys;
let MASKED_KEY;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-settings-route-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    const fileStore = await import('../lib/fileStore.js');
    const routes = await import('../routes/settings.js');
    settingsFile = fileStore.SETTINGS_FILE;
    maskApiKeys = routes.maskApiKeys;
    mergeApiKeys = routes.mergeApiKeys;
    MASKED_KEY = routes.MASKED_KEY;
    const app = express();
    app.use(express.json());
    app.use(routes.createSettingsRouter());
    request = supertest(app);
});

afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const payload = () => ({
    activeCampaignId: 'c1',
    settings: {
        theme: 'dark',
        providers: [
            { id: 'p1', label: 'GPU router', endpoint: 'http://192.168.2.110:8081/v1', apiKey: 'router-key-1', modelName: 'glm-5.3-flash-ablated' },
            { id: 'p2', label: 'Local', endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3' },
        ],
        presets: [{
            id: 'preset-1', name: 'Default',
            storyAI: { endpoint: 'https://a', apiKey: 'legacy-key', modelName: 'x' },
        }],
    },
});

function apiKeysIn(value, found = []) {
    if (Array.isArray(value)) value.forEach((v) => apiKeysIn(v, found));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (k === 'apiKey') found.push(v);
            else apiKeysIn(v, found);
        }
    }
    return found;
}

describe('maskApiKeys', () => {
    it('replaces every stored key with the marker and leaves the rest alone', () => {
        const masked = maskApiKeys(payload());
        expect(apiKeysIn(masked)).toEqual([MASKED_KEY, '', MASKED_KEY]);
        expect(masked.settings.providers[0].endpoint).toBe('http://192.168.2.110:8081/v1');
        expect(masked.settings.theme).toBe('dark');
        expect(masked.activeCampaignId).toBe('c1');
    });
    it('does not mutate its input', () => {
        const input = payload();
        maskApiKeys(input);
        expect(input.settings.providers[0].apiKey).toBe('router-key-1');
    });
    it('passes non-objects through', () => {
        expect(maskApiKeys(null)).toBe(null);
        expect(maskApiKeys('x')).toBe('x');
    });
});

describe('mergeApiKeys', () => {
    it('keeps the stored key when the incoming value is the mask', () => {
        const merged = mergeApiKeys(
            { settings: { providers: [{ id: 'p1', apiKey: MASKED_KEY }] } },
            { settings: { providers: [{ id: 'p1', apiKey: 'router-key-1' }] } },
        );
        expect(merged.settings.providers[0].apiKey).toBe('router-key-1');
    });
    it('takes the incoming key when it is a real value', () => {
        const merged = mergeApiKeys(
            { settings: { providers: [{ id: 'p1', apiKey: 'new-key' }] } },
            { settings: { providers: [{ id: 'p1', apiKey: 'old-key' }] } },
        );
        expect(merged.settings.providers[0].apiKey).toBe('new-key');
    });
    it('a mask against no stored key yields an empty key, never a literal mask', () => {
        const merged = mergeApiKeys({ settings: { providers: [{ id: 'p9', apiKey: MASKED_KEY }] } }, {});
        expect(merged.settings.providers[0].apiKey).toBe('');
    });
});

describe('PUT /api/settings', () => {
    it('writes the real keys to disk', async () => {
        const res = await request.put('/api/settings').send(payload());
        expect(res.status).toBe(200);
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        expect(onDisk.settings.providers[0].apiKey).toBe('router-key-1');
        expect(onDisk.settings.presets[0].storyAI.apiKey).toBe('legacy-key');
        expect(onDisk.settings.theme).toBe('dark');
    });

    it('never returns a key from GET — only the mask', async () => {
        await request.put('/api/settings').send(payload());
        const res = await request.get('/api/settings');
        expect(res.status).toBe(200);
        expect(apiKeysIn(res.body)).toEqual([MASKED_KEY, '', MASKED_KEY]);
        expect(res.body.settings.theme).toBe('dark');
    });

    it('a masked round-trip preserves the stored key', async () => {
        await request.put('/api/settings').send(payload());
        const fetched = await request.get('/api/settings');
        fetched.body.settings.theme = 'light';
        await request.put('/api/settings').send(fetched.body);
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        expect(onDisk.settings.providers[0].apiKey).toBe('router-key-1');
        expect(onDisk.settings.theme).toBe('light');
    });

    it('an empty key clears the stored one', async () => {
        await request.put('/api/settings').send(payload());
        const next = payload();
        next.settings.providers[0].apiKey = '';
        await request.put('/api/settings').send(next);
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        expect(onDisk.settings.providers[0].apiKey).toBe('');
    });

    it('the PUT response echoes the masked settings, never the secret', async () => {
        const res = await request.put('/api/settings').send(payload());
        expect(JSON.stringify(res.body)).not.toContain('router-key-1');
        expect(res.body.settings.providers[0].apiKey).toBe(MASKED_KEY);
    });
});
