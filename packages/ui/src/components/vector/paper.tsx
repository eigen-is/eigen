import { getBackgroundStyle } from '@workspace/lib/background';
import { frameClipRadius, type MediaResolver, parseBackgroundFill, type VectorFrame } from '@workspace/lib/vector';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

// Where a canvas puts its PAPER — the light-pinned surface that renders user content (.eigen-paper in
// globals.css re-declares the whole light palette, so a page keeps its light rendering in dark mode).
//
// The infinite canvas IS its paper: meta.background paints edge to edge, there is no region outside
// the drawing, so the container carries the pin. A framed canvas letterboxes one page instead: the
// surface around the page is the app's own furniture and follows the theme (bg-muted — dark in dark
// mode), and the pin moves onto the page card plus the chrome layers that dress it. Keeping the chrome
// on the paper's palette is what stops a resize grip (bg-background) from going dark grey on a white
// slide, and an empty-element outline (--border) from fading out on it.
export const CANVAS_PAPER_CLASS = 'eigen-paper';

export function canvasSurfaceClass(framed: boolean): string {
    return framed ? 'bg-muted' : `${CANVAS_PAPER_CLASS} bg-background`;
}

type FramePageProps = {
    frame: VectorFrame;
    zoom: number;
    resolveMediaUrl: MediaResolver;
    children: ReactNode;
};

// A frame is a page, drawn as a CARD: its own background inside a slightly rounded box that CLIPS what
// overhangs it, so the user sees where the page ends. This is the scene-layer half — the paint and the
// rounded clip, whose radius counter-scales the zoom (frameClipRadius); the card's border ring is drawn
// in the screen-space chrome layer, where a 1px border is really 1px. Everything token-based inside the
// card — the in-place rich-text editor above all — resolves against the paper's light palette.
export function FramePage({ frame, zoom, resolveMediaUrl, children }: FramePageProps) {
    return (
        <div
            // overflow-CLIP, not hidden: `hidden` makes the page a scroll container, and the browser
            // scrolls one to reveal a focused contenteditable's caret — which slid the whole page up
            // under the screen-space chrome, leaving the selection ring behind (the probe measured
            // 123.5px). `clip` clips identically and cannot be scrolled by anyone.
            className={cn(CANVAS_PAPER_CLASS, 'absolute overflow-clip')}
            style={{
                left: 0,
                top: 0,
                width: frame.width,
                height: frame.height,
                borderRadius: frameClipRadius(zoom),
                ...getBackgroundStyle(parseBackgroundFill(frame.background), resolveMediaUrl),
            }}
        >
            {children}
        </div>
    );
}
