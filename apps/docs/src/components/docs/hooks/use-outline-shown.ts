// Whether the doc's outline is shown. A desktop shows it beside the page and remembers the choice in this browser, so
// every doc opens with the outline as the last one was left. A phone shows it as a pane that hides the editor, so the
// pane opens only from the kebab and is forgotten when the doc closes.

import { useState } from 'react';

const OUTLINE_KEY = 'eigen-docs-outline';

// Storage a browser refuses, as in some private windows, leaves the outline hidden.
function readStoredShown(): boolean {
    try {
        return localStorage.getItem(OUTLINE_KEY) === 'shown';
    } catch {
        return false;
    }
}

export function useOutlineShown(isMobile: boolean): { shown: boolean; toggle: () => void; close: () => void } {
    const [stored, setStored] = useState(readStoredShown);
    const [pane, setPane] = useState(false);
    const shown = isMobile ? pane : stored;

    const show = (next: boolean) => {
        if (isMobile) {
            setPane(next);
            return;
        }
        setStored(next);
        try {
            localStorage.setItem(OUTLINE_KEY, next ? 'shown' : 'hidden');
        } catch {}
    };

    return { shown, toggle: () => show(!shown), close: () => show(false) };
}
