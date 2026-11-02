// Whether a dialog or a menu is open, read from the DOM. A document-level keymap folds these into its
// `enabled`, such as the canvas's or the mail list's: the hotkey lib's own guard covers text fields only,
// so a key pressed on a dialog button or in an open menu would otherwise act on the document behind it.

import { useSyncExternalStore } from 'react';

// Is a modal open? Every one carries role="dialog", such as a Radix dialog, an alert dialog, a popover or
// the file preview, so the DOM is the one source. An overlay that is a dialog itself, such as the mail
// cheat sheet, registers its keys ungated.
//
// Presence rather than focus: a dialog opened from a context menu has no trigger left to return focus
// to, so its close lands focus on <body> without an event, and a focus-based gate would stick shut.
// Radix keeps a closing dialog mounted as data-state="closed" for its exit animation.
const OPEN_DIALOG = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])';

// An open menu, such as a bar menu or a dropdown. A menu still fading out after a pick is not open.
export const OPEN_MENU = '[role="menu"][data-state="open"]';

// One observer for every subscriber, alive only while one is mounted.
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    if (!observer) {
        observer = new MutationObserver(() => {
            for (const listener of listeners) listener();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributeFilter: ['data-state'] });
    }
    return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
            observer?.disconnect();
            observer = null;
        }
    };
}

const getServerSnapshot = () => false;

export function useDialogOpen(): boolean {
    return useSyncExternalStore(subscribe, () => document.querySelector(OPEN_DIALOG) !== null, getServerSnapshot);
}

// Is a menu open? A bar menu leaves the page live, so its arrow keys, Delete and letters reach the
// document keymap too.
export function useMenuOpen(): boolean {
    return useSyncExternalStore(subscribe, () => document.querySelector(OPEN_MENU) !== null, getServerSnapshot);
}
