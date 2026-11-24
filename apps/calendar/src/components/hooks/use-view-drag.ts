// One drag at a time over a calendar view, such as an event moved across the month or a range drawn on the time grid.
// The view says how the drag follows the pointer, what its release lands and how its preview clears. The hook keeps
// the click a browser sends after the drag, or after Escape while the pointer stays captured, from opening anything;
// the next press forgets it, so a click that never came can't eat a later one.

import { usePointerDrag } from '@workspace/ui/hooks/use-pointer-drag';
import { useRef } from 'react';

type DragSteps = { move: (e: PointerEvent) => void; land: () => void; stop: () => void };

type UseViewDragReturn = {
    runDrag: (e: React.PointerEvent<HTMLElement>, steps: DragSteps) => void;
    rootProps: {
        onPointerDownCapture: () => void;
        onClickCapture: (e: React.MouseEvent) => void;
    };
};

export function useViewDrag(): UseViewDragReturn {
    const startPointerDrag = usePointerDrag();
    const swallowRef = useRef(false);
    return {
        runDrag: (e, { move, land, stop }) => {
            let travelled = false;
            startPointerDrag(e, {
                move: (me) => {
                    travelled = true;
                    move(me);
                },
                end: () => {
                    stop();
                    if (!travelled) return;
                    swallowRef.current = true;
                    land();
                },
                cancel: () => {
                    stop();
                    swallowRef.current = true;
                },
            });
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
