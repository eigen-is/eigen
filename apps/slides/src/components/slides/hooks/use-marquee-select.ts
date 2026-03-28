import { useCallback, useRef, useState } from 'react';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH, type SlideObject } from '../types';

type MarqueeRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

type UseMarqueeSelectProps = {
    objects: SlideObject[];
    canvasRef: React.RefObject<HTMLDivElement | null>;
    onSelect: (objectIds: string[]) => void;
};

export const useMarqueeSelect = ({ objects, canvasRef, onSelect }: UseMarqueeSelectProps) => {
    const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
    const marqueeRef = useRef<MarqueeRect | null>(null);
    marqueeRef.current = marquee;
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

                setMarquee({
                    x: Math.min(s.x, c.x),
                    y: Math.min(s.y, c.y),
                    w: Math.abs(c.x - s.x),
                    h: Math.abs(c.y - s.y),
                });
            };

            const handleMouseUp = () => {
                const rect = marqueeRef.current;
                if (rect) {
                    const selected = objectsRef.current
                        .filter(
                            (obj) =>
                                obj.x >= rect.x &&
                                obj.y >= rect.y &&
                                obj.x + obj.w <= rect.x + rect.w &&
                                obj.y + obj.h <= rect.y + rect.h,
                        )
                        .map((obj) => obj.id);

                    if (selected.length > 0) {
                        onSelect(selected);
                    }
                }
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
