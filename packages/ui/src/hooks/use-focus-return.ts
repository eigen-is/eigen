// Gives the focus back when a Radix dialog closes, such as a DialogContent or the file preview. Radix gives the focus
// back only to a DialogTrigger. A dialog opened from a menu or by a key would leave it on the page body, and a list's
// arrow keys would then do nothing until a click. The dialog calls this hook as it opens and passes what it returns as
// its onCloseAutoFocus. A closing menu calls returnFocusTo or handFocusReturnTo, which hand its list or its trigger to
// a dialog one of its rows opened. The focus comes back with a focus ring only if its target had one as it left, so a
// button a mouse clicked, such as a row's hover-revealed ⋮, doesn't draw one, and stays hidden once the pointer leaves.

import type { RefObject } from 'react';
import { useLayoutEffect, useState } from 'react';

// Where one open dialog gives the focus back, and whether the target had a focus ring as it lost the focus.
type FocusReturn = { content: RefObject<HTMLElement | null>; target: HTMLElement | null; ring: boolean };

// The open dialogs. Each portals its own content, so no two hold the same element.
const openDialogs = new Set<FocusReturn>();

// The page body is what has the focus when nothing does.
const focusedElement = () =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;

// Whether the element shows a focus ring, which a browser draws for a Tab and not for a mouse click.
export const hasFocusRing = (element: HTMLElement) => element.matches(':focus-visible');

// `content` is the dialog's content element, and `onCloseAutoFocus` the caller's own handler. The caller's handler
// runs first, and one that prevents the default keeps the focus where it put it.
export function useFocusReturn(
    content: RefObject<HTMLElement | null>,
    onCloseAutoFocus?: (event: Event) => void,
): (event: Event) => void {
    // Read as the dialog renders, before a field's autoFocus or Radix moves the focus into it.
    const [entry] = useState<FocusReturn>(() => {
        const target = focusedElement();
        return { content, target, ring: !target || hasFocusRing(target) };
    });

    // A menu row that opened the dialog is gone a moment later. A context menu hands its list over and a dropdown
    // menu its trigger through returnFocusTo, and a bar menu its trigger through handFocusReturnTo. Otherwise, such
    // as for a menu its owner opened, whose trigger Radix focuses as it closes, the first element outside every open
    // dialog that takes the focus becomes the target. A target still on the page stays, and a field in a dialog
    // opened over this one never becomes it.
    useLayoutEffect(() => {
        const replaceLostTarget = (event: FocusEvent) => {
            const focused = event.target;
            if (entry.target?.isConnected || !(focused instanceof HTMLElement)) return;
            if ([...openDialogs].some((open) => open.content.current?.contains(focused))) return;
            entry.target = focused;
            entry.ring = hasFocusRing(focused);
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
        const { target, ring } = entry;
        if (event.defaultPrevented || !target?.isConnected) return;
        event.preventDefault();
        returnFocusTo(target, ring);
    };
}

// Gives the focus back to `target` as a dialog or a menu closes. Whatever took the focus meanwhile keeps it, such as a
// dialog that a menu or palette row opened, or a field the row focused. Pulling the focus out of a dialog that just
// opened would make its focus trap take it back and select its text. The row that opened that dialog is gone, so the
// dialog gives the focus back to `target` when it closes. Pass ring false for a target that had no focus ring as it
// left, and none is drawn.
export function returnFocusTo(target: HTMLElement, ring?: boolean) {
    if (focusedElement()) handFocusReturnTo(target, ring);
    // A list taller than the window keeps its scroll, as Radix's own focus does.
    else target.focus({ preventScroll: true, ...(ring === false ? { focusVisible: false } : {}) });
}

// Makes `target` where the dialog that holds the focus gives it back, if what had the focus as that dialog opened is
// gone, such as the menu row that opened it. The focus itself stays where it is. Without `ring` the dialog keeps the
// ring of the row, which a browser drew for a key and not for a mouse, so the menu's opener decides.
export function handFocusReturnTo(target: HTMLElement, ring?: boolean) {
    const focused = focusedElement();
    const holder = focused && [...openDialogs].find((open) => open.content.current?.contains(focused));
    if (!holder || holder.target?.isConnected) return;
    holder.target = target;
    holder.ring = ring ?? holder.ring;
}
