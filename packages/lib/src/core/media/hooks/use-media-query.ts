import { useCallback, useSyncExternalStore } from 'react';

// One MediaQueryList per query string, so subscribe/getSnapshot never re-allocate
// (an inline subscribe would make useSyncExternalStore re-subscribe every render).
const mediaQueryLists = new Map<string, MediaQueryList>();

function getMediaQueryList(query: string): MediaQueryList {
    let media = mediaQueryLists.get(query);
    if (!media) {
        media = window.matchMedia(query);
        mediaQueryLists.set(query, media);
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

export function useIsMobile() {
    return useMediaQuery('(max-width: 768px)');
}

export function useIsTablet() {
    return useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
}

export function useIsDesktop() {
    return useMediaQuery('(min-width: 1025px)');
}

export function useIsCoarsePointer() {
    return useMediaQuery('(pointer: coarse)');
}
