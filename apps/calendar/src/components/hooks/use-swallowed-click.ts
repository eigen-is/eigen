// Keeps the click a browser sends after a drag from opening anything, for the calendar views that drag events, such
// as the time grid and the month. It comes after a release, and after Escape too, since the pointer stays captured. A
// view spreads rootProps on its root and calls swallowNextClick when a drag ends or is cancelled; the next press
// forgets it, so a click that never came can't eat a later one.

import { useRef } from 'react';

type UseSwallowedClickReturn = {
    swallowNextClick: () => void;
    rootProps: {
        onPointerDownCapture: () => void;
        onClickCapture: (e: React.MouseEvent) => void;
    };
};

export function useSwallowedClick(): UseSwallowedClickReturn {
    const swallowRef = useRef(false);
    return {
        swallowNextClick: () => {
            swallowRef.current = true;
        },
        rootProps: {
            onPointerDownCapture: () => {
                swallowRef.current = false;
            },
            onClickCapture: (e) => {
                if (!swallowRef.current) return;
                swallowRef.current = false;
                e.stopPropagation();
            },
        },
    };
}
