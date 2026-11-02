// Focus for a hand-rolled full-screen overlay that is no Radix dialog, such as the landing page's media
// preview. It moves the focus into the overlay on open, keeps Tab cycling inside it, and gives the focus back
// to whatever had it before the overlay opened. It joins none of Radix's stacks, so a Radix dialog under it
// keeps its own focus trap and scroll lock: an overlay that can open over one is a Radix dialog itself.

import type { RefObject } from 'react';
import { useEffect } from 'react';

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
    // Capture the trigger on mount (before focus moves in) and restore it on unmount.
    useEffect(() => {
        const previouslyFocused = document.activeElement;
        return () => {
            if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
        };
    }, []);

    useEffect(() => {
        const container = ref.current;
        if (!container) return;

        if (!container.contains(document.activeElement)) container.focus();

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            if (focusables.length === 0) {
                // Nothing focusable inside (e.g. an image-only lightbox): hold focus on the
                // container itself rather than letting Tab walk into the page behind it. Escape
                // still closes, so the user is never stuck.
                e.preventDefault();
                container.focus();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const activeEl = document.activeElement;
            if (e.shiftKey && activeEl === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && activeEl === last) {
                e.preventDefault();
                first.focus();
            } else if (!container.contains(activeEl)) {
                e.preventDefault();
                first.focus();
            }
        };

        container.addEventListener('keydown', handleKeyDown);
        return () => container.removeEventListener('keydown', handleKeyDown);
    }, [ref]);
}
