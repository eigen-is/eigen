// React hooks over CSS media queries, such as whether the window is phone-sized or the pointer is a finger. Layout
// and components across the apps read them, and code outside React that needs the phone breakpoint, such as a route's
// redirect, reads its query from here so the breakpoint is written once.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

const MOBILE_MAX_WIDTH = 768;

export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

// A prerender reads false, the desktop, so it agrees with the first client render; the client reads the real value
// at once, so it never flashes. The memoized query keeps subscribe stable across renders.
export function useMediaQuery(query: string): boolean {
    const media = useMemo(() => (typeof window === 'undefined' ? undefined : window.matchMedia(query)), [query]);
    const subscribe = useCallback(
        (onChange: () => void) => {
            media?.addEventListener('change', onChange);
            return () => media?.removeEventListener('change', onChange);
        },
        [media],
    );
    return useSyncExternalStore(
        subscribe,
        () => media?.matches ?? false,
        () => false,
    );
}

export function useIsMobile(): boolean {
    return useMediaQuery(MOBILE_MEDIA_QUERY);
}

export function useIsTablet(): boolean {
    return useMediaQuery(`(min-width: ${MOBILE_MAX_WIDTH + 1}px) and (max-width: 1024px)`);
}

export function useIsDesktop(): boolean {
    return useMediaQuery('(min-width: 1025px)');
}

// Toolbar density only: below this the editors fold their format rows into dropdowns. Not the phone breakpoint that
// useLayout().isMobile reports.
export function useIsCompactToolbar(): boolean {
    return useMediaQuery('(max-width: 1200px)');
}

export function useIsCoarsePointer(): boolean {
    return useMediaQuery('(pointer: coarse)');
}
