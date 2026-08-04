import { type RefObject, useEffect } from 'react';

// Modal focus management for the hand-rolled full-screen overlays (FilePreview, MediaPreview)
// that can't be Radix Dialogs because of their z-index / pointer-down choreography. Moves focus
// into the container on open, keeps Tab cycling inside it, and restores focus to the element that
// was focused before it opened. `active` suspends the trap while a nested modal (a Radix dialog
// portaled elsewhere in the DOM) owns focus, so the two don't fight over it.
const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
    // Capture the trigger on mount (before focus moves in) and restore it on unmount.
    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        return () => previouslyFocused?.focus();
    }, []);

    useEffect(() => {
        const container = ref.current;
        if (!active || !container) return;

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
    }, [ref, active]);
}
