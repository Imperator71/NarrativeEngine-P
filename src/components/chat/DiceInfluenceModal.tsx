import { useEffect, useRef, useState } from 'react';
import { Dices, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { DiceInfluence } from '../../services/engine/engineRolls';

/**
 * DICE INFLUENCE — the GM's hand on the engine's own rolls.
 *
 * The engines pre-roll (world events, the fairness pool, the GM's roll_dice
 * calls) and assert the result to the model as FACT, so the only honest place
 * to steer them is before that assertion. This modal writes a state onto the
 * campaign context; `resolveEngineRolls` applies it and burns one use, and the
 * turn bubble says so — a steered roll that looked untouched would be a lied
 * transcript.
 */

const MODES: { mode: DiceInfluence['mode']; label: string; hint: string }[] = [
    { mode: 'min', label: 'At least', hint: 'No influenced roll below this value (clamped to the die).' },
    { mode: 'max', label: 'At most', hint: 'No influenced roll above this value (clamped to the die).' },
    { mode: 'plus', label: 'Shift', hint: 'Adds to every influenced roll; a negative value subtracts.' },
    { mode: 'exact', label: 'Set', hint: 'Every influenced roll comes out exactly this value.' },
];

export function DiceInfluenceModal() {
    const open = useAppStore(s => s.diceInfluenceModalOpen);
    const onClose = useAppStore(s => s.closeDiceInfluenceModal);
    const context = useAppStore(s => s.context);
    const updateContext = useAppStore(s => s.updateContext);

    const current = context.diceInfluence ?? null;
    const [mode, setMode] = useState<DiceInfluence['mode']>(current?.mode ?? 'min');
    const [value, setValue] = useState<number>(current?.value ?? 12);
    const [usesLeft, setUsesLeft] = useState<number | null>(current?.usesLeft ?? null);
    const openedAtRef = useRef(0);

    // Re-seed from the context each time the dialog opens: the state lives on
    // the campaign, not in this component, so a reopen must not show stale knobs.
    useEffect(() => {
        if (!open) return;
        openedAtRef.current = Date.now();
        const s = context.diceInfluence ?? null;
        setMode(s?.mode ?? 'min');
        setValue(s?.value ?? 12);
        setUsesLeft(s?.usesLeft ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    if (!open) return null;

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const apply = () => {
        updateContext({ diceInfluence: { mode, value, usesLeft } });
        onClose();
    };

    const turnOff = () => {
        updateContext({ diceInfluence: undefined });
        onClose();
    };

    const hint = MODES.find(m => m.mode === mode)?.hint ?? '';
    const preview = `${mode === 'plus' && value > 0 ? '+' : ''}${value}`;

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60" onClick={handleBackdropClick}>
            <div className="bg-surface border border-border rounded-lg w-full max-w-sm mx-4 flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Dices size={14} /> Dice Influence
                    </h2>
                    <button onClick={onClose} className="text-text-dim hover:text-text-primary">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Mode</div>
                        <div className="grid grid-cols-4 gap-1">
                            {MODES.map(m => (
                                <button
                                    key={m.mode}
                                    onClick={() => setMode(m.mode)}
                                    className={`px-1 py-1.5 text-[10px] rounded border transition-all ${
                                        m.mode === mode
                                            ? 'bg-terminal/20 border-terminal text-terminal'
                                            : 'bg-void border-border text-text-dim hover:text-text-primary'
                                    }`}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-text-dim/70 leading-relaxed mt-1">{hint}</p>
                    </div>

                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Value</div>
                        <div className="flex items-center gap-2">
                            <button onClick={() => setValue(v => v - 1)} className="px-3 py-1.5 text-xs bg-void border border-border rounded hover:border-terminal">−</button>
                            <input
                                type="number"
                                value={value}
                                onChange={e => setValue(parseInt(e.target.value) || 0)}
                                className="flex-1 bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none text-center"
                            />
                            <button onClick={() => setValue(v => v + 1)} className="px-3 py-1.5 text-xs bg-void border border-border rounded hover:border-terminal">+</button>
                        </div>
                    </div>

                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">Duration</div>
                        <div className="grid grid-cols-3 gap-1">
                            {([
                                { label: 'Until off', uses: null },
                                { label: 'Next 1', uses: 1 },
                                { label: 'Next 3', uses: 3 },
                            ] as const).map(opt => (
                                <button
                                    key={opt.label}
                                    onClick={() => setUsesLeft(opt.uses)}
                                    className={`px-1 py-1.5 text-[10px] rounded border transition-all ${
                                        usesLeft === opt.uses
                                            ? 'bg-terminal/20 border-terminal text-terminal'
                                            : 'bg-void border-border text-text-dim hover:text-text-primary'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-text-dim/70 leading-relaxed mt-1">
                            One use burns per turn that resolves rolls, so &quot;next 1&quot; means the next turn with dice in it.
                        </p>
                    </div>

                    <div className="text-[11px] text-terminal font-mono bg-terminal/10 rounded px-2 py-1.5 text-center">
                        {MODES.find(m => m.mode === mode)?.label.toLowerCase()} {preview}
                        {usesLeft !== null ? ` · ${usesLeft} turn${usesLeft === 1 ? '' : 's'}` : ' · until off'}
                    </div>

                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Applies to the engine&apos;s own rolls: world events, the fairness pool and the GM&apos;s roll_dice calls.
                        Your own &quot;Dice Me&quot; rolls are never touched — those are yours.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={turnOff}
                        disabled={!current}
                        className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded disabled:opacity-30"
                    >
                        Turn off
                    </button>
                    <button onClick={apply} className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30">
                        Apply
                    </button>
                </div>
            </div>
        </div>
    );
}
