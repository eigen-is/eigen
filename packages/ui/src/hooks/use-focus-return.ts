// Gives the focus back when a Radix dialog closes, such as a DialogContent or the file preview. Radix gives the focus
// back only to a DialogTrigger. A dialog opened from a menu or by a key would leave it on the page body, and a list's
// arrow keys would then do nothing until a click. The dialog calls this hook as it opens and passes what it returns as
// its onCloseAutoFocus.

import type { RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';

// Where one open dialog gives the focus back.
type FocusReturn = { content: RefObject<HTMLElement | null>; target: HTMLElement | null };

// The open dialogs. Each portals its own content, so no two hold the same element.
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
    // from as it closes. The first element outside every open dialog that takes the focus then becomes the target. A
    // target still on the page stays, and a field in a dialog opened over this one never becomes it.
    useLayoutEffect(() => {
        const replaceLostTarget = (event: FocusEvent) => {
            const focused = event.target;
            if (entry.target?.isConnected || !(focused instanceof HTMLElement)) return;
            if (![...openDialogs].some((open) => open.content.current?.contains(focused))) entry.target = focused;
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
        // Pulling the focus out of a dialog that just opened makes its focus trap take it back and select its text.
        // So whatever took the focus as this dialog closed keeps it, such as a dialog that a palette row opened.
        // The row that opened that dialog is gone, so that dialog gives the focus back to this one's target instead.
        const focused = focusedElement();
        if (focused) {
            const holder = [...openDialogs].find((open) => open.content.current?.contains(focused));
            if (holder && !holder.target?.isConnected) holder.target = target;
            return;
        }
        event.preventDefault();
        // A list taller than the window keeps its scroll, as Radix's own focus does.
        target.focus({ preventScroll: true });
    };
}
