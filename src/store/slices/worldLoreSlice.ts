import type { StateCreator } from 'zustand';
import type { WorldLoreDraft, WorldLoreItem } from '../../types';
import { uid } from '../../utils/uid';
import { API_BASE as API } from '../../lib/apiBase';

/**
 * World lore drafts are user content, not a device preference, so the server
 * owns them (`data/worlds.json`, `GET/PUT /api/worlds`).
 *
 * They used to live in `localStorage.nn_world_lore_drafts`, which made a built
 * world invisible on any other device: the campaign created from it loaded fine
 * while the builder said "No draft selected". The legacy key is read once and
 * migrated up, so nothing a user already wrote is lost.
 */
const LEGACY_STORAGE_KEY = 'nn_world_lore_drafts';

async function fetchDrafts(): Promise<WorldLoreDraft[]> {
    try {
        const res = await fetch(`${API}/worlds`);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.drafts) ? data.drafts : [];
    } catch (e) {
        console.error('[WorldLore] Failed to load drafts from the server:', e);
        return [];
    }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistDrafts(drafts: WorldLoreDraft[]) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch(`${API}/worlds`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ drafts }),
        }).catch((e) => console.error('[WorldLore] Failed to save drafts to the server:', e));
    }, 400);
}

function readLegacyDrafts(): WorldLoreDraft[] {
    try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

const EMPTY_DRAFT: Omit<WorldLoreDraft, 'id' | 'name' | 'createdAt' | 'updatedAt'> = {
    background: '',
    languages: '',
    powerSystem: '',
    techEconomy: '',
    timeline: '',
    toneBoundaries: '',
    houseRules: '',
    locations: [],
    cultures: [],
    factions: [],
    threats: [],
    npcs: [],
    characterCreationQuestions: '',
};

export type WorldLoreSlice = {
    worldLoreDrafts: WorldLoreDraft[];
    worldLoreActiveDraftId: string | null;
    worldLoreModalOpen: boolean;

    createDraft: (name?: string) => string;
    importWorldDraft: (draft: WorldLoreDraft) => void;
    deleteDraft: (id: string) => void;
    updateDraftField: <K extends keyof WorldLoreDraft>(id: string, field: K, value: WorldLoreDraft[K]) => void;
    addItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', item?: WorldLoreItem) => void;
    updateItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', itemId: string, patch: Partial<WorldLoreItem>) => void;
    removeItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', itemId: string) => void;
    setActiveDraft: (id: string | null) => void;
    toggleWorldLoreModal: () => void;
    loadWorldLoreDrafts: () => Promise<void>;
};

export const createWorldLoreSlice: StateCreator<WorldLoreSlice, [], [], WorldLoreSlice> = (set, get) => ({
    worldLoreDrafts: [],
    worldLoreActiveDraftId: null,
    worldLoreModalOpen: false,

    createDraft: (name?: string) => {
        const now = Date.now();
        const draft: WorldLoreDraft = {
            id: uid(),
            name: name || `World ${get().worldLoreDrafts.length + 1}`,
            ...EMPTY_DRAFT,
            createdAt: now,
            updatedAt: now,
        };
        set((s) => {
            const drafts = [...s.worldLoreDrafts, draft];
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts, worldLoreActiveDraftId: draft.id };
        });
        return draft.id;
    },

    importWorldDraft: (draft) => {
        const copy = { ...draft, id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
        const drafts = [...get().worldLoreDrafts, copy];
        // Import must not report success when the save failed — persistDrafts
        // logs the failure rather than swallowing it silently.
        persistDrafts(drafts);
        set({ worldLoreDrafts: drafts, worldLoreActiveDraftId: copy.id });
    },

    deleteDraft: (id) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.filter((d) => d.id !== id);
            persistDrafts(drafts);
            const activeId = s.worldLoreActiveDraftId === id ? null : s.worldLoreActiveDraftId;
            return { worldLoreDrafts: drafts, worldLoreActiveDraftId: activeId };
        });
    },

    updateDraftField: (id, field, value) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id ? { ...d, [field]: value, updatedAt: Date.now() } : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    addItem: (id, listKey, item) => {
        const newItem: WorldLoreItem = item ?? { id: uid(), title: '', body: '' };
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id ? { ...d, [listKey]: [...d[listKey], newItem], updatedAt: Date.now() } : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    updateItem: (id, listKey, itemId, patch) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id
                    ? {
                          ...d,
                          [listKey]: d[listKey].map((item) =>
                              item.id === itemId ? { ...item, ...patch } : item
                          ),
                          updatedAt: Date.now(),
                      }
                    : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    removeItem: (id, listKey, itemId) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id
                    ? { ...d, [listKey]: d[listKey].filter((item) => item.id !== itemId), updatedAt: Date.now() }
                    : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    setActiveDraft: (id) => set({ worldLoreActiveDraftId: id }),

    toggleWorldLoreModal: () => set((s) => ({ worldLoreModalOpen: !s.worldLoreModalOpen })),

    loadWorldLoreDrafts: async () => {
        let drafts = await fetchDrafts();
        // One-time migration: anything a browser still holds from the old
        // localStorage store is pushed up rather than abandoned.
        if (drafts.length === 0) {
            const legacy = readLegacyDrafts();
            if (legacy.length > 0) {
                drafts = legacy;
                persistDrafts(legacy);
                try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* private mode */ }
            }
        }
        set({ worldLoreDrafts: drafts });
    },
});