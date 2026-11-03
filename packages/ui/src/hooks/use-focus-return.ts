// Gives the focus back when a Radix dialog closes, such as a DialogContent or the file preview. No Eigen dialog has a
// Radix trigger, so Radix alone would leave the focus on the page body, and a list's arrow keys would do nothing until
// a click. The dialog calls this hook as it opens and passes what it returns as its onCloseAutoFocus.

import type { RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';

// Where one open dialog gives the focus back.
type FocusReturn = { content: RefObject<HTMLElement | null>; target: HTMLElement | null };

// The open dialogs, oldest first.
const openDialogs = new Set<FocusReturn>();

// The page body is what has the focus when nothing does.
const focusedElement = () =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;

// `content` is the dialog's content element, and `onCloseAutoFocus` the caller's own handler. The caller's handler
// runs first, and one that prevents the default keeps the focus where it put it.
export function useFocusReturn(
    content: RefObject<HTMLElement | null>,
    onCloseAutoFocus?: (event: Event) => void,
): (event: Event) => void {
    // Read as the dialog renders, before a field's autoFocus or Radix moves the focus into it.
    const [entry] = useState<FocusReturn>(() => ({ content, target: focusedElement() }));

    // A menu row that opened the dialog is gone a moment later, and the menu gives the focus back to the list it came
    // from as it closes. The first element outside the dialog that takes the focus then becomes the target. A target
    // still on the page stays, so the fields of a dialog opened over this one never replace it.
    useLayoutEffect(() => {
        const replaceLostTarget = (event: FocusEvent) => {
            if (entry.target?.isConnected || !(event.target instanceof HTMLElement)) return;
            if (!entry.content.current?.contains(event.target)) entry.target = event.target;
        };
        openDialogs.add(entry);
        document.addEventListener('focusin', replaceLostTarget);
        return () => {
            document.removeEventListener('focusin', replaceLostTarget);
            openDialogs.delete(entry);
        };
    }, [entry]);

    // Radix calls this a moment after the dialog is gone.
    return (event: Event) => {
        onCloseAutoFocus?.(event);
        const { target } = entry;
        if (event.defaultPrevented || !target?.isConnected) return;
        // Something took the focus as the dialog closed, such as a dialog a palette row opened. It keeps the focus,
        // and moving it away would make that dialog's focus trap take it back and select its field's text.
        const focused = focusedElement();
        if (focused) {
            handOver(focused, target);
            return;
        }
        event.preventDefault();
        target.focus();
    };
}

// The dialog that took the focus opened while this one closed, so its own target is gone, such as the palette row
// that opened it. It gives the focus back where this one would have.
function handOver(focused: HTMLElement, target: HTMLElement) {
    const holder = [...openDialogs].findLast((open) => open.content.current?.contains(focused));
    if (holder && !holder.target?.isConnected) holder.target = target;
}
