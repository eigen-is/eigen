// Whether the focus sits inside a detail column, such as a reply box in a comment thread beside a canvas. A document
// keymap or an app shortcut folds it into its `enabled` beside useDialogOpen: a column has no focus trap, so Delete on
// its Resolve button or ⌘Z in its reply box would otherwise act on the document behind it.

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
    document.addEventListener('focusin', onChange);
    document.addEventListener('focusout', onChange);
    return () => {
        document.removeEventListener('focusin', onChange);
        document.removeEventListener('focusout', onChange);
    };
}

const getSnapshot = () => document.activeElement?.closest('[data-slot="detail-column"]') != null;
const getServerSnapshot = () => false;

export function useFocusInDetail(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
