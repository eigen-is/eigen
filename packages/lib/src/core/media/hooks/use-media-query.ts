import { useCallback, useSyncExternalStore } from 'react';

// One MediaQueryList per query string, so subscribe/getSnapshot never re-allocate
// (an inline subscribe would make useSyncExternalStore re-subscribe every render). Kept per window: each
// component test file installs a window of its own in one process, and a list from the last one never
// sees this one's viewport.
const mediaQueryLists = new WeakMap<Window, Map<string, MediaQueryList>>();

function getMediaQueryList(query: string): MediaQueryList {
    let lists = mediaQueryLists.get(window);
    if (!lists) {
        lists = new Map();
        mediaQueryLists.set(window, lists);
    }
    let media = lists.get(query);
    if (!media) {
        media = window.matchMedia(query);
        lists.set(query, media);
    }
    return media;
}

// Prerender-safe media query hook. `getServerSnapshot` returns false (desktop
// default) so a build-time render and the first client render agree — no
// hydration mismatch. On the client `getSnapshot` reads the real value
// synchronously, so client-only apps see no first-render flash.
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback(
        (onChange: () => void) => {
            if (typeof window === 'undefined') return () => {};
            const media = getMediaQueryList(query);
            media.addEventListener('change', onChange);
            return () => media.removeEventListener('change', onChange);
        },
        [query],
    );
    return useSyncExternalStore(
        subscribe,
        () => getMediaQueryList(query).matches,
        () => false,
    );
}

export function useIsMobile(): boolean {
    return useMediaQuery('(max-width: 768px)');
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
