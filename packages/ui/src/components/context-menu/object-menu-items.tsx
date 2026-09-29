// The object context menu's shared row groups, one set of labels and order for every host (the writes
// stay host-side), plus every embedded image's download row.

import { downloadDriveFile } from '@workspace/lib/download';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    ArrowDownToLine,
    ArrowUpToLine,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    Copy,
    CopyPlus,
    Download,
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

// Every embedded image's download row (canvas, docs, sheets). The host resolves the image's media name
// to its path; none yet (a pending upload, a deleted file) hides the row.
export function DownloadImageMenuItem({ path }: { path?: DrivePath | null }) {
    if (!path) return null;
    return (
        <DropdownMenuItem onClick={() => downloadDriveFile(path)}>
            <Download className="h-4 w-4 mr-2" /> Download original image
        </DropdownMenuItem>
    );
}
