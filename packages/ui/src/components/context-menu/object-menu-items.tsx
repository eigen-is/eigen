// Shared object context-menu item groups for canvas apps (vector, slides). Presentational only —
// they render the singleton context menu's DropdownMenuItem rows and speak U4c's `ZOp` vocabulary,
// but the WRITES stay per-app (vector rewrites fractional indices, slides splices a Y.Array). Each
// host feeds callbacks and composes the separators between groups; app-specific rows (slides' Copy +
// comment items, vector's future clipboard rows) stay host-side. Labels + order are the single source
// so the two apps' menus read byte-identically. Home is the context-menu dir — these are menu-item
// builders for the useContextMenu singleton — and they borrow the `ZOp` union from the properties
// panel's Arrange chrome so the vocabulary lives in one place.

import {
    ArrowDownToLine,
    ArrowUpToLine,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    Copy,
    CopyPlus,
    Scissors,
    Trash2,
} from 'lucide-react';
import { DropdownMenuItem } from '../dropdown-menu';
import type { ZOp } from '../properties-panel/z-order';

// The Arrange group: Bring to front / Bring forward / Send backward / Send to back (front at top,
// matching the properties-panel order + labels). Presentational — the host owns what each op does.
export function ArrangeMenuItems({ onApply }: { onApply: (op: ZOp) => void }) {
    return (
        <>
            <DropdownMenuItem onClick={() => onApply('toFront')}>
                <ArrowUpToLine className="h-4 w-4 mr-2" /> Bring to front
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApply('forward')}>
                <ChevronUp className="h-4 w-4 mr-2" /> Bring forward
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApply('backward')}>
                <ChevronDown className="h-4 w-4 mr-2" /> Send backward
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onApply('toBack')}>
                <ArrowDownToLine className="h-4 w-4 mr-2" /> Send to back
            </DropdownMenuItem>
        </>
    );
}

// Clipboard group: Copy / Cut / Paste. Each row appears only when its callback is supplied, so a host
// with only synchronous copy (slides today) and one with the full set (vector) compose the same
// builder. Labels + order are the single source so the apps' menus read identically.
export function ClipboardMenuItems({
    onCopy,
    onCut,
    onPaste,
}: {
    onCopy?: () => void;
    onCut?: () => void;
    onPaste?: () => void;
}) {
    return (
        <>
            {onCopy && (
                <DropdownMenuItem onClick={onCopy}>
                    <Copy className="h-4 w-4 mr-2" /> Copy
                </DropdownMenuItem>
            )}
            {onCut && (
                <DropdownMenuItem onClick={onCut}>
                    <Scissors className="h-4 w-4 mr-2" /> Cut
                </DropdownMenuItem>
            )}
            {onPaste && (
                <DropdownMenuItem onClick={onPaste}>
                    <ClipboardPaste className="h-4 w-4 mr-2" /> Paste
                </DropdownMenuItem>
            )}
        </>
    );
}

// Generic object actions: Duplicate then Delete. Each row appears only when its callback is supplied,
// so slides (Delete only — it duplicates via ⌘D / Alt-drag, not the menu) and vector (both) compose
// the same group. Delete stays the destructive variant.
export function ObjectActionMenuItems({ onDuplicate, onDelete }: { onDuplicate?: () => void; onDelete?: () => void }) {
    return (
        <>
            {onDuplicate && (
                <DropdownMenuItem onClick={onDuplicate}>
                    <CopyPlus className="h-4 w-4 mr-2" /> Duplicate
                </DropdownMenuItem>
            )}
            {onDelete && (
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                </DropdownMenuItem>
            )}
        </>
    );
}
