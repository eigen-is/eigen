import { type Bounds, type MarqueeMode, marqueeHits, marqueeMode } from '@workspace/lib/vector';
import { useCallback, useRef, useState } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';

// Drag direction determines selection mode (AutoCAD/Figma convention) via the shared U6c helper:
// rightward = 'contain' (object fully inside marquee), leftward = 'intersect' (object overlaps).
type MarqueeRect = {
    x: number;
    y: number;
    w: number;
    h: number;
    mode: MarqueeMode;
};

type UseMarqueeSelectProps = {
    objects: SlideObject[];
    canvasRef: React.RefObject<HTMLDivElement | null>;
    onSelect: (objectIds: string[]) => void;
};

export const useMarqueeSelect = ({ objects, canvasRef, onSelect }: UseMarqueeSelectProps) => {
    const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
    const startRef = useRef<{ clientX: number; clientY: number } | null>(null);
    const objectsRef = useRef(objects);
    objectsRef.current = objects;

    const getSlideCoords = useCallback(
        (clientX: number, clientY: number) => {
            const el = canvasRef.current;
            if (!el) return { x: 0, y: 0 };
            const rect = el.getBoundingClientRect();
            return {
                x: ((clientX - rect.left) / rect.width) * SLIDE_BASE_WIDTH,
                y: ((clientY - rect.top) / rect.height) * SLIDE_BASE_HEIGHT,
            };
        },
        [canvasRef],
    );

    const startMarquee = useCallback(
        (e: React.MouseEvent) => {
            startRef.current = { clientX: e.clientX, clientY: e.clientY };

            const handleMouseMove = (me: MouseEvent) => {
                const start = startRef.current;
                if (!start) return;

                // Only start showing marquee after a small threshold to avoid flickering on clicks
                const dist = Math.abs(me.clientX - start.clientX) + Math.abs(me.clientY - start.clientY);
                if (dist < 5) return;

                const s = getSlideCoords(start.clientX, start.clientY);
                const c = getSlideCoords(me.clientX, me.clientY);
                const mode = marqueeMode(start.clientX, me.clientX);
                const rect: MarqueeRect = {
                    x: Math.min(s.x, c.x),
                    y: Math.min(s.y, c.y),
                    w: Math.abs(c.x - s.x),
                    h: Math.abs(c.y - s.y),
                    mode,
                };
                setMarquee(rect);

                // Live update (slides adopts vector's live-selection during the drag — U6c). The empty
                // canvas mousedown already cleared, so reflecting the current hits (empty included)
                // never independently clears a user's selection.
                const marq: Bounds = { minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h };
                const selected = objectsRef.current
                    .filter((obj) =>
                        marqueeHits(
                            { minX: obj.x, minY: obj.y, maxX: obj.x + obj.width, maxY: obj.y + obj.height },
                            marq,
                            mode,
                        ),
                    )
                    .map((obj) => obj.id);
                onSelect(selected);
            };

            const handleMouseUp = () => {
                // Selection was applied live during the move; just tear the marquee down.
                setMarquee(null);
                startRef.current = null;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [getSlideCoords, onSelect],
    );

    return { marquee, startMarquee };
};
