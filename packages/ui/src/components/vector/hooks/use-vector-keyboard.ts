// Every canvas keyboard command except the layered Escape (that one lives in the canvas because it
// reads live gesture state to cancel an in-progress create/marquee/move). Bindings go through
// @tanstack/react-hotkeys (available from packages/ui) mirroring the slides editor's useHotkey +
// enabled-gating discipline, so shortcuts keep working while focus sits off-canvas and auto-ignore
// text inputs. The z-order brackets are a manual event.code listener: the hotkey lib matches by
// event.key (⌘⇧[ arrives as '{') and its type surface forbids Shift+punctuation.

import { useHotkey } from '@tanstack/react-hotkeys';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import { generateNKeysBetween, orderByFractionalIndex, type VectorElement } from '@workspace/lib/vector';
import { useEffect, useRef } from 'react';
import type * as Y from 'yjs';
import type { VectorTool } from './use-tool';
import type { VectorElementPatch } from './use-vector-doc';

const NUDGE = 1;
const NUDGE_LARGE = 5;
const DUPLICATE_OFFSET = 10;

// The manual listeners' equivalent of the hotkey lib's input gate; the canvas reuses it for its
// own Space/Escape listeners.
export function isTypingTarget(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

type ZOp = 'backward' | 'forward' | 'toBack' | 'toFront';

// Fractional-index rewrites for a z-order change. The selection moves as a block relative to the
// NON-selected elements, so a non-contiguous multi-selection collapses into one clean gap
// (Excalidraw's raise/lower semantics); for a single element this reduces to a one-step swap.
// Returns {id, index} per moved element, or [] for a no-op.
function computeZOrder(ordered: VectorElement[], selectedIds: string[], op: ZOp): { id: string; index: string }[] {
    const sel = ordered.filter((e) => selectedIds.includes(e.id));
    const nonSel = ordered.filter((e) => !selectedIds.includes(e.id));
    if (sel.length === 0) return [];

    let keys: string[];
    if (op === 'toFront') {
        keys = generateNKeysBetween(nonSel[nonSel.length - 1]?.index ?? null, null, sel.length);
    } else if (op === 'toBack') {
        keys = generateNKeysBetween(null, nonSel[0]?.index ?? null, sel.length);
    } else if (op === 'forward') {
        if (nonSel.length === 0) return [];
        const topPos = ordered.indexOf(sel[sel.length - 1]);
        const above = ordered.slice(topPos + 1).find((e) => !selectedIds.includes(e.id));
        if (!above) return []; // block already above every non-selected element
        const aboveInNon = nonSel.indexOf(above);
        keys = generateNKeysBetween(above.index, nonSel[aboveInNon + 1]?.index ?? null, sel.length);
    } else {
        if (nonSel.length === 0) return [];
        const bottomPos = ordered.indexOf(sel[0]);
        const below = ordered
            .slice(0, bottomPos)
            .reverse()
            .find((e) => !selectedIds.includes(e.id));
        if (!below) return []; // block already below every non-selected element
        const belowInNon = nonSel.indexOf(below);
        keys = generateNKeysBetween(nonSel[belowInNon - 1]?.index ?? null, below.index, sel.length);
    }
    return sel.map((e, i) => ({ id: e.id, index: keys[i] }));
}

type VectorKeyboardParams = {
    enabled: boolean;
    elements: VectorElement[];
    selectedIds: string[];
    tool: VectorTool;
    setTool: (t: VectorTool) => void;
    setSelection: (ids: string[]) => void;
    undoManager: Y.UndoManager | null;
    deleteElements: (ids: string[]) => void;
    updateElements: (patches: { id: string; fields: VectorElementPatch }[]) => void;
    duplicateElements: (ids: string[], dx: number, dy: number) => string[];
};

export function useVectorKeyboard(params: VectorKeyboardParams) {
    const { enabled, elements, selectedIds, setTool, setSelection, undoManager } = params;
    const { deleteElements, updateElements, duplicateElements } = params;
    const hasSelection = selectedIds.length > 0;

    // Undo/redo through the doc's own UndoManager (⌘Z / ⌘⇧Z / ⌘Y).
    useYjsUndoHotkeys(undoManager, enabled);

    // Tools — single keys, so the lib's ignoreInputs default keeps them off while typing elsewhere.
    useHotkey('V', () => setTool('select'), { enabled });
    useHotkey('1', () => setTool('select'), { enabled });
    useHotkey('R', () => setTool('rectangle'), { enabled });
    useHotkey('2', () => setTool('rectangle'), { enabled });
    useHotkey('D', () => setTool('diamond'), { enabled });
    useHotkey('3', () => setTool('diamond'), { enabled });
    useHotkey('O', () => setTool('ellipse'), { enabled });
    useHotkey('4', () => setTool('ellipse'), { enabled });

    // Discrete ops seal the undo group on BOTH sides: stopCapturing before opens a fresh step,
    // stopCapturing after keeps a nudge inside the 500ms capture window from merging into it.
    // Nudges themselves carry neither, so rapid taps still coalesce.
    const del = () => {
        undoManager?.stopCapturing();
        deleteElements(selectedIds);
        undoManager?.stopCapturing();
        setSelection([]);
    };
    useHotkey('Delete', del, { enabled: enabled && hasSelection });
    useHotkey('Backspace', del, { enabled: enabled && hasSelection });

    // Mod combos default ignoreInputs off, so opt in — ⌘A must not hijack select-all in an input.
    useHotkey(
        'Mod+A',
        (e) => {
            e.preventDefault();
            setSelection(elements.map((el) => el.id));
        },
        { enabled: enabled && elements.length > 0, ignoreInputs: true },
    );
    useHotkey(
        'Mod+D',
        (e) => {
            e.preventDefault();
            undoManager?.stopCapturing();
            const ids = duplicateElements(selectedIds, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
            undoManager?.stopCapturing();
            if (ids.length) setSelection(ids);
        },
        { enabled: enabled && hasSelection, ignoreInputs: true },
    );

    // Nudge — 1px, Shift 5px (scene units). One transact per press (undo coalesces rapid taps).
    const nudge = (dx: number, dy: number) => {
        const byId = new Map(elements.map((el) => [el.id, el]));
        const patches = selectedIds
            .map((id) => byId.get(id))
            .filter((el): el is VectorElement => !!el)
            .map((el) => ({ id: el.id, fields: { x: el.x + dx, y: el.y + dy } }));
        if (patches.length) updateElements(patches);
    };
    const arrow = (dx: number, dy: number) => (e: KeyboardEvent) => {
        e.preventDefault();
        nudge(dx, dy);
    };
    const nudgeEnabled = { enabled: enabled && hasSelection };
    useHotkey('ArrowLeft', arrow(-NUDGE, 0), nudgeEnabled);
    useHotkey('ArrowRight', arrow(NUDGE, 0), nudgeEnabled);
    useHotkey('ArrowUp', arrow(0, -NUDGE), nudgeEnabled);
    useHotkey('ArrowDown', arrow(0, NUDGE), nudgeEnabled);
    useHotkey('Shift+ArrowLeft', arrow(-NUDGE_LARGE, 0), nudgeEnabled);
    useHotkey('Shift+ArrowRight', arrow(NUDGE_LARGE, 0), nudgeEnabled);
    useHotkey('Shift+ArrowUp', arrow(0, -NUDGE_LARGE), nudgeEnabled);
    useHotkey('Shift+ArrowDown', arrow(0, NUDGE_LARGE), nudgeEnabled);

    // Z-order: ⌘[/⌘] step, ⌘⇧[/⌘⇧] to back/front. Manual listener keyed on event.code (see header).
    const stateRef = useRef({ enabled, elements, selectedIds });
    stateRef.current = { enabled, elements, selectedIds };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
            const { enabled: on, elements: els, selectedIds: ids } = stateRef.current;
            if (!on || ids.length === 0 || isTypingTarget()) return;
            e.preventDefault();
            const op: ZOp =
                e.code === 'BracketLeft' ? (e.shiftKey ? 'toBack' : 'backward') : e.shiftKey ? 'toFront' : 'forward';
            const patches = computeZOrder(orderByFractionalIndex(els), ids, op);
            if (patches.length) {
                undoManager?.stopCapturing();
                updateElements(patches.map((p) => ({ id: p.id, fields: { index: p.index } })));
                undoManager?.stopCapturing();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [undoManager, updateElements]);
}
