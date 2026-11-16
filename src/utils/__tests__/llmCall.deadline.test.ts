import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
const acquireMock = vi.fn();
const releaseMock = vi.fn();

vi.mock('../../services/llm/llmFetch', () => ({ llmFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../../services/llm/llmRequestQueue', () => ({
    getQueueForEndpoint: () => ({
        acquireSlot: () => acquireMock(),
        releaseSlot: () => releaseMock(),
        onRateLimitHit: () => { /* no-op */ },
    }),
}));
vi.mock('../llmApiHelper', () => ({
    getApiFormat: () => 'openai',
    getChatUrl: () => 'http://endpoint.test/v1/chat/completions',
    buildChatHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildChatBody: () => ({ messages: [] }),
    extractContent: (data: { choices: { message: { content: string } }[] }) => data.choices[0].message.content,
}));

const { llmCall, UtilityTimeoutError } = await import('../llmCall');

function okResponse(content = 'ok') {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => content,
    };
}

const endpoint = { id: 'test', endpoint: 'http://endpoint.test', modelName: 'test-model' } as never;

function never(): Promise<Response> {
    return new Promise<Response>(() => { /* never settles */ });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('llmCall deadlines', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        acquireMock.mockReset().mockResolvedValue(undefined);
        releaseMock.mockReset();
    });

    it('honours timeoutMs even without a trackingLabel', async () => {
        fetchMock.mockImplementation(() => never());
        const started = Date.now();
        await expect(llmCall(endpoint, 'x', { timeoutMs: 80 }))
            .rejects.toBeInstanceOf(UtilityTimeoutError);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('does not charge queue wait against the model budget', async () => {
        // 50 ms behind other calls, then the model itself takes 80 ms, against a
        // 100 ms budget: total 130 ms. It must succeed, because the clock restarts
        // when the request gets its slot.
        acquireMock.mockImplementation(async () => { await sleep(50); });
        fetchMock.mockImplementation(async () => { await sleep(80); return okResponse('survived'); });
        await expect(llmCall(endpoint, 'x', { timeoutMs: 100 })).resolves.toBe('survived');
    });

    it('still gives up when the queue wait alone exceeds the budget', async () => {
        // The initial clock bounds queue wait, so a jammed queue cannot hold a call
        // forever. 150 ms of waiting against a 100 ms budget is a timeout.
        acquireMock.mockImplementation(async () => { await sleep(150); });
        fetchMock.mockResolvedValue(okResponse('too late'));
        await expect(llmCall(endpoint, 'x', { timeoutMs: 100 }))
            .rejects.toBeInstanceOf(UtilityTimeoutError);
    });

    it('still times out when the model itself is slow', async () => {
        acquireMock.mockResolvedValue(undefined);
        fetchMock.mockImplementation(() => never());
        await expect(llmCall(endpoint, 'x', { timeoutMs: 60 }))
            .rejects.toBeInstanceOf(UtilityTimeoutError);
    });

    it('releases the queue slot on a successful call', async () => {
        fetchMock.mockResolvedValue(okResponse());
        await llmCall(endpoint, 'x', { timeoutMs: 500 });
        expect(releaseMock).toHaveBeenCalled();
    });
});
