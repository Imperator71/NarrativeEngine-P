import type { EndpointConfig, ProviderConfig, ThinkingEffort } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from '../services/llm/llmRequestQueue';
import { getApiFormat, getChatUrl, buildChatHeaders, buildChatBody, extractContent } from './llmApiHelper';
import { startUtilityCall, type UtilityCallHandle } from '../services/llm/utilityCallTracker';
import { recordCacheUsage, type LLMUsage } from '../services/llm/cacheTelemetry';
import { llmFetch } from '../services/llm/llmFetch';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export class UtilityTimeoutError extends Error {
    elapsedMs: number;
    label: string;
    constructor(elapsedMs: number, label: string) {
        super(`Utility call "${label}" exceeded deadline (${elapsedMs}ms)`);
        this.name = 'UtilityTimeoutError';
        this.elapsedMs = elapsedMs;
        this.label = label;
    }
}

export async function llmCall(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
        /** If set, registers this call with utilityCallTracker so UI can show countdown + EXTEND. */
        trackingLabel?: string;
        /** Soft deadline in ms. On expiry, rejects with UtilityTimeoutError. Caller should fall back. */
        timeoutMs?: number;
    }
): Promise<string> {
    const timeoutMs = typeof opts?.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
    // Tracking and the deadline are separate concerns: tracking is the UI strip, the
    // deadline is correctness. A timeoutMs without a trackingLabel used to be ignored
    // outright, so such a call could hang forever.
    if (!timeoutMs) {
        return runInner(provider, prompt, opts);
    }

    const label = opts?.trackingLabel;
    const trackingName = (provider as EndpointConfig).modelName || provider.endpoint;
    const handle = label ? startUtilityCall(label, trackingName, timeoutMs, 'utility') : null;
    const startedAt = Date.now();

    // Wire abort: when the deadline elapses, cancel the in-flight fetch too.
    const ownAbort = new AbortController();
    const combinedSignal = opts?.signal
        ? AbortSignal.any([opts.signal, ownAbort.signal])
        : ownAbort.signal;

    // The deadline armed at start covers the queue wait, so a jammed queue cannot
    // make a call wait forever. `armForCall` then grants the model its full budget
    // once the request actually has a slot — see runInner.
    let deadlinePromise: Promise<void>;
    let armForCall: () => void;
    if (handle) {
        deadlinePromise = handle.deadlinePromise;
        armForCall = () => handle.armForCall();
    } else {
        // Mirrors the tracker's re-checking deadline: the promise only resolves when
        // the clock has genuinely run out, so moving the deadline forward (armForCall)
        // keeps the same promise pending instead of settling it early.
        let deadline = Date.now() + timeoutMs;
        let wake: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        deadlinePromise = (async () => {
            for (;;) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) return;
                await new Promise<void>(resolve => {
                    wake = resolve;
                    timer = setTimeout(resolve, remaining);
                });
                if (timer) clearTimeout(timer);
                wake = null;
            }
        })();
        armForCall = () => {
            deadline = Date.now() + timeoutMs;
            if (wake) {
                if (timer) clearTimeout(timer);
                const resume = wake;
                wake = null;
                resume();
            }
        };
    }

    const inner = runInner(provider, prompt, { ...opts, signal: combinedSignal }, handle ?? undefined, armForCall);

    try {
        const result = await Promise.race([
            inner.then(v => ({ kind: 'ok' as const, value: v })),
            deadlinePromise.then(() => ({ kind: 'timeout' as const })),
        ]);

        if (result.kind === 'timeout') {
            ownAbort.abort();
            // The aborted fetch rejects after the race has already settled; without
            // this the rejection surfaces as an unhandled promise.
            void inner.catch(() => { /* aborted by the deadline */ });
            handle?.settleError('timeout');
            throw new UtilityTimeoutError(Date.now() - startedAt, label ?? 'utility call');
        }

        handle?.settleSuccess();
        return result.value;
    } catch (e) {
        // If inner threw before deadline, record it.
        if (!(e instanceof UtilityTimeoutError)) {
            const msg = e instanceof Error ? e.message : String(e);
            handle?.settleError('error', msg);
        }
        throw e;
    }
}

async function runInner(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
        trackingLabel?: string;
    },
    call?: UtilityCallHandle,
    onSlotAcquired?: () => void,
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const format = getApiFormat(provider);
    const resolvedEffort = opts?.thinkingEffort !== undefined ? opts.thinkingEffort : (provider as EndpointConfig).thinkingEffort;

    const body = buildChatBody(
        provider,
        [{ role: 'user', content: prompt }],
        { stream: false, max_tokens: opts?.maxTokens, thinkingEffort: resolvedEffort }
    );

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const priority = opts?.priority ?? 'low';
    const queue = getQueueForEndpoint(provider.endpoint, (provider as EndpointConfig).maxConcurrent);

    let fetchUrl = url;
    if (format === 'gemini' && provider.apiKey) {
        const sep = fetchUrl.includes('?') ? '&' : '?';
        fetchUrl = `${fetchUrl}${sep}key=${provider.apiKey}`;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);
        // The request is about to leave: start the model's own clock now, so queue
        // wait is not charged against the timeout budget. Only the first attempt
        // re-arms; retries share whatever remains.
        if (attempt === 0) onSlotAcquired?.();

        let res: Response;
        try {
            res = await llmFetch(fetchUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: opts?.signal,
            }, call);
        } catch (e) {
            queue.releaseSlot();
            throw e;
        }

        const retryable = res.status === 429 || res.status === 503 || res.status === 529;
        if (!retryable) {
            queue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
            }
            const data = await res.json();
            if (opts?.trackingLabel) {
                recordCacheUsage(opts.trackingLabel, (data as { usage?: LLMUsage }).usage);
            }
            return extractContent(data, provider);
        }

        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error ${res.status} (retries exhausted): ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[LLMQueue] Unreachable');
}
