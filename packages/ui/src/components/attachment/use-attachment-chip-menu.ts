import type React from 'react';
import { useCallback, useRef } from 'react';
import { useLongPress } from '../../hooks/use-long-press';
import { useContextMenu } from '../context-menu/use-context-menu';
import { attachmentKeyAt } from './simple-attachment-chip';

// What a surface builds its menu target from: the row the press landed on (a chat message, or
// nothing at all for a chip list) and the key of the chip under the pointer, if any. Returning
// undefined opens no menu. Keep it in a useCallback — the handlers it feeds are memoised on it.
type ToMenuItem<H, T> = (host: H, chipKey: string | null) => T | undefined;

export type AttachmentChipMenu<H, T> = {
    contextMenu: ReturnType<typeof useContextMenu<T>>;
    // Spread on the element holding the chips; `host` is the row the press belongs to.
    bind: (host: H) => ReturnType<ReturnType<typeof useLongPress<H>>['bind']> & {
        onContextMenu: (e: React.MouseEvent) => void;
        onPointerDownCapture: (e: React.PointerEvent) => void;
    };
};

// The one wiring from an attachment chip to the singleton context menu, shared by the mail reader,
// the chat message list and the card dialog. Right-click on a pointer device, long-press on touch,
// and the chip under the finger read back from the DOM — a long-press only reports where it started.
export function useAttachmentChipMenu<H, T>(toMenuItem: ToMenuItem<H, T>): AttachmentChipMenu<H, T> {
    const contextMenu = useContextMenu<T>();
    const { openAt, handleContextMenu } = contextMenu;
    const pressedChip = useRef<string | null>(null);

    const handleLongPress = useCallback(
        (host: H, x: number, y: number) => {
            const item = toMenuItem(host, pressedChip.current);
            if (item === undefined) return false;
            openAt(item, x, y);
            return true;
        },
        [openAt, toMenuItem],
    );
    const longPress = useLongPress<H>(handleLongPress);
    const bindLongPress = longPress.bind;

    const bind = useCallback(
        (host: H) => ({
            onContextMenu: (e: React.MouseEvent) => {
                const chipKey = attachmentKeyAt(e.target);
                // Leave links and text selected under the pointer to the browser's native copy menu. A
                // chip is an anchor too, and it has its own rows to offer.
                const selection = window.getSelection();
                if (!chipKey && e.target instanceof HTMLElement && e.target.closest('a')) return;
                if (
                    selection &&
                    !selection.isCollapsed &&
                    e.target instanceof Node &&
                    selection.containsNode(e.target, true)
                )
                    return;
                const item = toMenuItem(host, chipKey);
                if (item !== undefined) handleContextMenu(e, item);
            },
            onPointerDownCapture: (e: React.PointerEvent) => {
                pressedChip.current = attachmentKeyAt(e.target);
            },
            ...bindLongPress(host),
        }),
        [bindLongPress, handleContextMenu, toMenuItem],
    );

    return { contextMenu, bind };
}
