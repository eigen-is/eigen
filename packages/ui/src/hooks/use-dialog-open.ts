import { useSyncExternalStore } from 'react';

// Is a modal open? Every one carries role="dialog" (Radix dialogs, alert dialogs and popovers; the
// hand-rolled overlays under `useFocusTrap`), so the DOM is the one source. The gate every
// document-level keymap folds into its `enabled`: the hotkey lib's own guard covers text fields only,
// so a key pressed on a dialog button would otherwise act on the document behind it. Overlays that are
// dialogs themselves (the file preview, the mail cheat sheet) register their keys ungated.
//
// Presence rather than focus: a dialog opened from a context menu has no trigger left to return focus
// to, so its close lands focus on <body> without an event, and a focus-based gate would stick shut.
// Radix keeps a closing dialog mounted as data-state="closed" for its exit animation.
const OPEN_DIALOG = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])';

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

const getSnapshot = () => document.querySelector(OPEN_DIALOG) !== null;
const getServerSnapshot = () => false;

export function useDialogOpen(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
