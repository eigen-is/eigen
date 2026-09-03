// Present mode: one slide, full screen, nothing else. It renders FrameView — the same read-only page
// the rail thumbnail draws — so what a presenter shows is what the editor showed, and links inside a
// rich-text box work because the layers take pointer events here.

import { useMediaResolver } from '@workspace/lib/drive';
import type { VectorElement, VectorFrame } from '@workspace/lib/vector';
import { FrameView } from '@workspace/ui/components/vector';
import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Where a click/right-click lands: the next index, or -1 for "leave present mode". Forward past the
// last slide ends the deck (the presenter's natural last click); backward from the first stays put,
// because leaving on a mis-click backwards would be a surprise.
export function presentStep(index: number, count: number, delta: number): number {
    if (count === 0) return -1;
    const next = index + delta;
    if (next >= count) return -1;
    return Math.max(next, 0);
}

// The exit affordance shows on entry and on any pointer activity, then fades away again.
const CONTROLS_MS = 2000;

type PresentModeProps = {
    frame: VectorFrame;
    elements: VectorElement[];
    onNext: () => void;
    onPrev: () => void;
    onExit: () => void;
};

export function PresentMode({ frame, elements, onNext, onPrev, onExit }: PresentModeProps) {
    const { resolveMediaUrl } = useMediaResolver();
    const [controlsVisible, setControlsVisible] = useState(true);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    const revealControls = useCallback(() => {
        setControlsVisible(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_MS);
    }, []);

    useEffect(() => {
        // React ignores autoFocus on a plain div (it is only acted on for form controls), so focus the
        // overlay ourselves — otherwise a clicker's keys land on the body and the deck never advances.
        overlayRef.current?.focus();
        revealControls();
        return () => clearTimeout(timerRef.current);
    }, [revealControls]);

    // A presentation clicker sends keys, not clicks: every one of them speaks Arrow/Page/space. The
    // handler is on the overlay itself (focused above), so it is scoped to present mode and cannot
    // collide with the canvas keymap, which is unmounted while presenting.
    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ';
            const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp';
            if (!forward && !back) return;
            e.preventDefault();
            revealControls();
            if (forward) onNext();
            else onPrev();
        },
        [onNext, onPrev, revealControls],
    );

    return (
        <div
            ref={overlayRef}
            // The overlay IS the presentation surface: it holds focus so a clicker's keys reach it.
            tabIndex={0}
            onKeyDown={onKeyDown}
            // Full-screen present sits at the documented full-screen tier (z-100, like FilePreview),
            // not the portal tier, so it covers the app chrome instead of tying with it.
            className={cn(
                'fixed inset-0 z-[100] flex items-center justify-center bg-black',
                !controlsVisible && 'cursor-none',
            )}
            onPointerMove={revealControls}
            onClick={() => {
                revealControls();
                onNext();
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onPrev();
            }}
        >
            <FrameView
                frame={frame}
                elements={elements}
                resolveMedia={resolveMediaUrl}
                interactive
                className="w-full max-h-full"
            />
            <button
                type="button"
                title="Exit present (Esc)"
                aria-label="Exit present"
                tabIndex={controlsVisible ? undefined : -1}
                // Hidden means gone, so a tap in this corner still advances the deck.
                className={cn(
                    'absolute top-4 right-4 rounded-full bg-black/50 p-2.5 pointer-coarse:p-3 text-white transition-opacity hover:bg-black/70',
                    !controlsVisible && 'pointer-events-none opacity-0',
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    onExit();
                }}
            >
                <X className="size-5" />
            </button>
        </div>
    );
}
