import {useEffect, useState} from 'react';

/**
 * Hook to simplify working with media queries
 * @param query Media query string to evaluate
 * @returns boolean indicating if the media query matches
 */
export function useMediaQuery(query: string) {
    const [matches, setMatches] = useState(false);

    useEffect(() => {
        // Set initial value
        const media = window.matchMedia(query);
        setMatches(media.matches);

        // Add listener for changes
        const listener = () => setMatches(media.matches);
        media.addEventListener('change', listener);

        // Clean up
        return () => media.removeEventListener('change', listener);
    }, [query]);

    return matches;
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
