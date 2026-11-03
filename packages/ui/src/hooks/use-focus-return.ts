// Gives the focus back when a Radix dialog closes, such as a DialogContent or the file preview. Radix gives the focus
// back only to a DialogTrigger. A dialog opened from a menu or by a key would leave it on the page body, and a list's
// arrow keys would then do nothing until a click. The dialog calls this hook as it opens and passes what it returns as
// its onCloseAutoFocus. A closing menu calls returnFocusTo or handFocusReturnTo, which hand its list or its trigger to
// a dialog one of its rows opened.

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

    // A menu row that opened the dialog is gone a moment later. A context menu hands its list over through
    // returnFocusTo and a bar menu its trigger through handFocusReturnTo, but a dropdown menu with its own Radix trigger
    // focuses that trigger as it closes. The first element outside
    // every open dialog that takes the focus then becomes the target. A target still on the page stays, and a field in
    // a dialog opened over this one never becomes it.
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
        event.preventDefault();
        returnFocusTo(target);
    };
}

// Gives the focus back to `target` as a dialog or a menu closes. Whatever took the focus meanwhile keeps it, such as a
// dialog that a menu or palette row opened, or a field the row focused. Pulling the focus out of a dialog that just
// opened would make its focus trap take it back and select its text. The row that opened that dialog is gone, so the
// dialog gives the focus back to `target` when it closes.
export function returnFocusTo(target: HTMLElement) {
    // A list taller than the window keeps its scroll, as Radix's own focus does.
    if (focusedElement()) handFocusReturnTo(target);
    else target.focus({ preventScroll: true });
}

// Makes `target` where the dialog that holds the focus gives it back, if what had the focus as that dialog opened is
// gone, such as the menu row that opened it. The focus itself stays where it is.
export function handFocusReturnTo(target: HTMLElement) {
    const focused = focusedElement();
    const holder = focused && [...openDialogs].find((open) => open.content.current?.contains(focused));
    if (holder && !holder.target?.isConnected) holder.target = target;
}
