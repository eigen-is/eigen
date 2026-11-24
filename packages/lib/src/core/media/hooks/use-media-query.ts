// React hooks over CSS media queries, such as whether the window is phone-sized or the pointer is a finger. Layout
// and components across the apps read them, and code outside React that needs the phone breakpoint, such as a route's
// redirect, reads its query from here so the breakpoint is written once.

import { useCallback, useMemo, useSyncExternalStore } from 'react';

export const MOBILE_MEDIA_QUERY = '(max-width: 768px)';

// Prerender-safe media query hook. `getServerSnapshot` returns false (desktop default) so a build-time render and the
// first client render agree — no hydration mismatch. On the client `getSnapshot` reads the real value synchronously,
// so client-only apps see no first-render flash. One list per query keeps subscribe's identity, which
// useSyncExternalStore would otherwise re-subscribe on every render.
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
    return useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
}

export function useIsDesktop(): boolean {
    return useMediaQuery('(min-width: 1025px)');
}

// Toolbar density only: below this the editors fold their format rows into dropdowns. Not the
// 768px system mobile breakpoint that useLayout().isMobile reports.
export function useIsCompactToolbar(): boolean {
    return useMediaQuery('(max-width: 1200px)');
}

export function useIsCoarsePointer(): boolean {
    return useMediaQuery('(pointer: coarse)');
}
