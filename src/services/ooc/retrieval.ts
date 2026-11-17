import { API_BASE as API } from '../../lib/apiBase';
import { fetchArchiveScenes, retrieveArchiveMemory } from '../archiveMemory';
import type { OocCampaignSnapshot, OocSource } from './types';

const short = (value: string, max = 700) => value.trim().replace(/\s+/g, ' ').slice(0, max);

export function shouldSearchOoc(question: string, forceSearch = false): boolean {
    // Retrieval used to require a keyword or a capitalised name, so a plain
    // mechanics question ("how does the dice system work") searched nothing and
    // answered from a 4-message transcript. Ask GM consults records on every
    // question now; the limits below are what bound the cost.
    return forceSearch || question.trim().length > 0;
}

async function semanticIds(campaignId: string, question: string, signal?: AbortSignal): Promise<{ archive: string[]; lore: string[]; rules: string[] }> {
    try {
        const body = JSON.stringify({ query: question, limit: 10 });
        const [archive, lore, rules] = await Promise.all([
            fetch(`${API}/campaigns/${campaignId}/archive/semantic-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
            fetch(`${API}/campaigns/${campaignId}/lore/semantic-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
            fetch(`${API}/campaigns/${campaignId}/rules/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
        ]);
        const parse = async (response: Response, key: 'sceneIds' | 'loreIds' | 'ruleIds') => {
            if (!response.ok) return [] as string[];
            const data = await response.json();
            return data.pending || !Array.isArray(data[key]) ? [] : data[key] as string[];
        };
        return {
            archive: await parse(archive, 'sceneIds'),
            lore: await parse(lore, 'loreIds'),
            rules: await parse(rules, 'ruleIds'),
        };
    } catch (error) {
        if (signal?.aborted) throw error;
        return { archive: [], lore: [], rules: [] };
    }
}

/** Read-only bounded retrieval for OOC. It does not construct a TurnState or call gatherContext. */
export async function searchCampaignRecords(
    snapshot: OocCampaignSnapshot,
    question: string,
    signal?: AbortSignal,
): Promise<{ text: string; sources: OocSource[] }> {
    if (!snapshot.campaignId) return { text: '', sources: [] };
    const semantic = await semanticIds(snapshot.campaignId, question, signal);
    const localArchiveIds = retrieveArchiveMemory(
        snapshot.archiveIndex, question, snapshot.messages, snapshot.npcLedger, 8,
        snapshot.semanticFacts, undefined, undefined, semantic.archive, undefined, undefined,
        undefined, 'lean', snapshot.campaignId,
    ).slice(0, 8);
    const archive = await fetchArchiveScenes(snapshot.campaignId, localArchiveIds, 1_200);
    const selectedLoreIds = new Set([...semantic.lore, ...semantic.rules]);
    const chunks = [...snapshot.loreChunks, ...(snapshot.context.rulesChunks ?? [])]
        .filter(chunk => selectedLoreIds.has(chunk.id) || (!selectedLoreIds.size && chunk.triggerKeywords.some(keyword => question.toLowerCase().includes(keyword.toLowerCase()))))
        .filter((chunk, index, all) => all.findIndex(other => other.id === chunk.id) === index)
        .slice(0, 10);
    const sources: OocSource[] = [
        ...archive.map(scene => ({ kind: 'archive' as const, id: scene.sceneId, label: `Archive scene ${scene.sceneId}`, excerpt: short(scene.content, 1_500) })),
        ...chunks.map(chunk => ({
            kind: (snapshot.context.rulesChunks ?? []).some(rule => rule.id === chunk.id) ? 'rules' as const : 'lore' as const,
            id: chunk.id,
            label: chunk.header || 'Campaign record',
            excerpt: short(chunk.summary || chunk.content, 1_200),
        })),
    ];
    const text = sources.map(source => `[${source.kind.toUpperCase()}: ${source.label}]\n${source.excerpt}`).join('\n\n');
    return { text, sources };
}
