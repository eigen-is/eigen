import type React from 'react';
import { useEffect, useRef } from 'react';

export function useOutsideClick(containerRef: React.RefObject<HTMLElement | null>, handler: () => void) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
                handlerRef.current();
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [containerRef]);
}
