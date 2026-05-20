import { useSyncExternalStore } from 'react';

// Prerender-safe media query hook. `getServerSnapshot` returns false (desktop
// default) so a build-time render and the first client render agree — no
// hydration mismatch. On the client `getSnapshot` reads the real value
// synchronously, so client-only apps see no first-render flash.
export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (onChange) => {
            if (typeof window === 'undefined') return () => {};
            const media = window.matchMedia(query);
            media.addEventListener('change', onChange);
            return () => media.removeEventListener('change', onChange);
        },
        () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
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
