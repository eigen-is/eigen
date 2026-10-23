// The object menus' shared rows, one set of labels and order for every host (the writes stay host-side), plus every
// embedded image's download row.

import { formatForDisplay } from '@tanstack/react-hotkeys';
import { downloadDriveFile } from '@workspace/lib/download';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ZOp } from '@workspace/lib/vector';
import {
    ArrowDownToLine,
    ArrowUpToLine,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    Copy,
    Download,
    Layers,
    Scissors,
} from 'lucide-react';
import {
    DropdownMenuItem,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../dropdown-menu';

// Google Slides' Order ▸, front at top, with the brackets useZOrderHotkeys answers to. Presentational: the host owns
// what each op does.
export function OrderMenuSub({ onApply }: { onApply: (op: ZOp) => void }) {
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Layers className="h-4 w-4" /> Order
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => onApply('toFront')}>
                    <ArrowUpToLine className="h-4 w-4" /> Bring to front
                    <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+]')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onApply('forward')}>
                    <ChevronUp className="h-4 w-4" /> Bring forward
                    <DropdownMenuShortcut>{formatForDisplay('Mod+]')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onApply('backward')}>
                    <ChevronDown className="h-4 w-4" /> Send backward
                    <DropdownMenuShortcut>{formatForDisplay('Mod+[')}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onApply('toBack')}>
                    <ArrowDownToLine className="h-4 w-4" /> Send to back
                    <DropdownMenuShortcut>{formatForDisplay('Mod+Shift+[')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

// Cut, Copy, Paste, the order of every Edit menu. Each row appears only when its callback is supplied, so a host
// that can only paste here (an empty canvas) and one with the full set compose the same rows.
export function ClipboardMenuItems({
    onCut,
    onCopy,
    onPaste,
}: {
    onCut?: () => void;
    onCopy?: () => void;
    onPaste?: () => void;
}) {
    return (
        <>
            {onCut && (
                <DropdownMenuItem onClick={onCut}>
                    <Scissors className="h-4 w-4" /> Cut
                    <DropdownMenuShortcut>{formatForDisplay('Mod+X')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
            {onCopy && (
                <DropdownMenuItem onClick={onCopy}>
                    <Copy className="h-4 w-4" /> Copy
                    <DropdownMenuShortcut>{formatForDisplay('Mod+C')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
            {onPaste && (
                <DropdownMenuItem onClick={onPaste}>
                    <ClipboardPaste className="h-4 w-4" /> Paste
                    <DropdownMenuShortcut>{formatForDisplay('Mod+V')}</DropdownMenuShortcut>
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
            <Download className="h-4 w-4" /> Download original image
        </DropdownMenuItem>
    );
}
