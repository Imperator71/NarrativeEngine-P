// POST /api/llm/proxy — only http(s) targets are relayed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { createLLMProxyRouter } from '../routes/llmProxy.js';

let request;
let fetchMock;

beforeEach(() => {
    fetchMock = vi.fn(async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
    }));
    const app = express();
    app.use(express.json());
    // The router takes its fetch by injection; it no longer calls the global.
    app.use(createLLMProxyRouter({ fetchImpl: fetchMock }));
    request = supertest(app);
});

afterEach(() => vi.restoreAllMocks());

describe('proxy target validation', () => {
    it('relays an https provider URL', async () => {
        const res = await request.post('/api/llm/proxy').send({
            target: 'https://api.example.test/v1/chat/completions', method: 'POST', headers: {}, body: '{}',
        });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/v1/chat/completions');
    });
    it('relays a plain-http local provider URL (Ollama, ComfyUI)', async () => {
        const res = await request.post('/api/llm/proxy').send({ target: 'http://localhost:11434/api/tags', method: 'GET' });
        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('refuses non-http schemes without fetching', async () => {
        for (const target of ['file:///C:/Windows/win.ini', 'data:text/plain,hi', 'ftp://x.test/y']) {
            const res = await request.post('/api/llm/proxy').send({ target });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/http\(s\)/);
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('refuses a target that is not a URL', async () => {
        const res = await request.post('/api/llm/proxy').send({ target: '/v1/models' });
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('still requires a target', async () => {
        const res = await request.post('/api/llm/proxy').send({});
        expect(res.status).toBe(400);
    });
});

describe('lone surrogate repair before the upstream fetch', () => {
    // A lone high surrogate: the first half of most emoji, with no low half.
    const LONE_HIGH = String.fromCharCode(0xd83d);
    const REPLACEMENT = String.fromCharCode(0xfffd);

    it('repairs an unpaired surrogate half in a JSON payload', async () => {
        // What the browser holds after a bad slice, serialized the way the client
        // sends it: the lone half is escaped, so the transport itself is fine and
        // only the provider's parse would expose it.
        const payload = JSON.stringify({ messages: [{ role: 'user', content: `apple ${LONE_HIGH} half` }] });
        const res = await request.post('/api/llm/proxy').send({
            target: 'https://api.example.test/v1/chat/completions',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
        });
        expect(res.status).toBe(200);

        const forwarded = fetchMock.mock.calls[0][1].body;
        const parsed = JSON.parse(forwarded);
        expect(parsed.messages[0].content).toBe(`apple ${REPLACEMENT} half`);
    });

    it('leaves a valid emoji pair intact', async () => {
        const good = 'calendar U+1F4C5: \u{1F4C5}';
        const res = await request.post('/api/llm/proxy').send({
            target: 'https://api.example.test/v1/chat/completions',
            body: JSON.stringify({ messages: [{ role: 'user', content: good }] }),
        });
        expect(res.status).toBe(200);
        const forwarded = fetchMock.mock.calls[0][1].body;
        expect(JSON.parse(forwarded).messages[0].content).toBe(good);
    });

    it('forwards a non-JSON body unchanged when it is well formed', async () => {
        const body = 'plain text prompt';
        const res = await request.post('/api/llm/proxy').send({
            target: 'https://api.example.test/v1/chat/completions',
            body,
        });
        expect(res.status).toBe(200);
        expect(fetchMock.mock.calls[0][1].body).toBe(body);
    });
});
