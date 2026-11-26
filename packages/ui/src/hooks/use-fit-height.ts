// Grows a message box, such as the chat composer or a message edited in place, with its text up to five lines, where it
// starts to scroll. The height follows the text however it changed: typed, completed from a list or put back after a
// failed send.

import type { RefObject } from 'react';
import { useLayoutEffect } from 'react';

// The box's max-h-[120px], so the height stops where the box starts to scroll.
const MAX_HEIGHT_PX = 120;

export function useFitHeight(textareaRef: RefObject<HTMLTextAreaElement | null>, text: string): void {
    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT_PX)}px`;
    }, [textareaRef, text]);
}
