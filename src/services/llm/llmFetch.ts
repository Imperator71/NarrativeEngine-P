import { API_BASE } from '../../lib/apiBase';
import type { UtilityCallHandle } from './utilityCallTracker';

/**
 * Drop-in fetch() replacement that relays an AI-provider request through the local
 * server instead of calling the provider directly from the browser. Avoids CORS
 * failures for providers (e.g. NVIDIA) that don't allow browser origins.
 *
 * Since the server owns the credentials, this function also:
 *   1. names the provider (`providerId`) so the server can look up its stored key,
 *   2. strips any Authorization / x-api-key header the caller still built, so a
 *      stale client copy can never transmit a secret.
 *
 * Call sites already pass a stringified JSON body and a plain headers object,
 * which is exactly what the proxy forwards.
 */

const CREDENTIAL_HEADER = /^(authorization|x-api-key|api-key|anthropic-version)$/i;

function stripCredentialHeaders(headers: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!headers) return out;
    const entries: [string, string][] = headers instanceof Headers
        ? Array.from(headers.entries())
        : Array.isArray(headers)
            ? (headers as [string, string][])
            : Object.entries(headers as Record<string, string>);
    for (const [name, value] of entries) {
        if (!CREDENTIAL_HEADER.test(name.trim())) out[name] = value;
    }
    return out;
}

type ProviderLike = { id: string; endpoint: string };

function normalise(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

/**
 * The proxy target is always `<provider.endpoint>/...`, so the provider is
 * implied by the URL. Resolving it here keeps every call site unchanged.
 */
export function providerIdForTarget(providers: ProviderLike[] | undefined, target: string): string | undefined {
    if (!Array.isArray(providers)) return undefined;
    const wanted = normalise(target);
    let best: ProviderLike | undefined;
    for (const provider of providers) {
        if (!provider || typeof provider.endpoint !== 'string' || !provider.endpoint) continue;
        const endpoint = normalise(provider.endpoint);
        if (wanted === endpoint || wanted.startsWith(`${endpoint}/`) || wanted.startsWith(`${endpoint}?`)) {
            // Longest matching endpoint wins when one provider's URL prefixes another.
            if (!best || provider.endpoint.length > best.endpoint.length) best = provider;
        }
    }
    return best?.id;
}

export async function llmFetch(target: string, init?: RequestInit, call?: UtilityCallHandle): Promise<Response> {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    // Loaded eagerly: the provider lookup below needs the store on every call.
    const { useAppStore } = await import('../../store/useAppStore');
    const state = useAppStore.getState();
    if (call && body !== undefined) {
        if (state.settings?.debugMode && !init?.signal?.aborted) {
            call.recordRequestBody(body);
        }
    }
    const providerId = providerIdForTarget(state.settings?.providers, target);
    return fetch(`${API_BASE}/llm/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target,
            method: init?.method ?? 'GET',
            headers: stripCredentialHeaders(init?.headers),
            body,
            providerId,
        }),
        signal: init?.signal ?? undefined,
    });
}
