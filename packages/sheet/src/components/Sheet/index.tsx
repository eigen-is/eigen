// The open sheet's grid: the canvas the cells are painted on and the overlay above it. It sizes the canvas to its
// placeholder and repaints at most once a frame. An edit draws the frame whole; a scroll alone moves the frame drawn
// before and paints what came into view.

import type React from 'react';
import { memo, useCallback, useContext, useEffect, useRef } from 'react';
import { WorkbookContext } from '../../context';
import type { Context } from '../../state';
import { freezeOf, updateContextWithCanvas, watchFontFaces } from '../../state';
import type { ScrollPos } from '../../state/render/frame';
import { drawFrame, scrollFrame } from '../../state/render/frame';
import { SheetOverlay } from '../SheetOverlay';

// What the canvas shows. When only the scroll changed since, scrollFrame moves it instead of drawing it again.
type DrawnFrame = { ctx: Context; scroll: ScrollPos };

const MemoizedSheetOverlay = memo(SheetOverlay);

export const Sheet: React.FC = () => {
    const placeholderRef = useRef<HTMLDivElement>(null);
    const { context, setContext, refs } = useContext(WorkbookContext);

    const contextRef = useRef(context);
    contextRef.current = context;

    const rafIdRef = useRef(0);
    // Sizing the canvas clears its bitmap, even to the same size, so whatever sizes it forgets the frame.
    const drawnRef = useRef<DrawnFrame | undefined>(undefined);
    // Latched by the 0×0 guards below so the rAF redraw skips a hidden surface.
    const visibleRef = useRef(true);

    const resize = useCallback(() => {
        // 0×0 = detaching or hidden; writing it would pin the canvas blank until the next resize.
        const placeholder = placeholderRef.current;
        if (!placeholder || placeholder.clientWidth === 0 || placeholder.clientHeight === 0) {
            visibleRef.current = false;
            return;
        }
        visibleRef.current = true;

        drawnRef.current = undefined;
        setContext((draftCtx) => {
            const canvas = refs.canvas.current;
            if (!canvas) return;
            draftCtx.devicePixelRatio = window.devicePixelRatio;
            updateContextWithCanvas(draftCtx, canvas, placeholder);
        });
    }, [refs.canvas, setContext]);

    // Window resize covers devicePixelRatio changes, the observer container-only ones (panels, un-hiding).
    // No feedback loop: the placeholder is sized by its flex parent, canvas and overlay are absolute.
    useEffect(() => {
        const placeholder = placeholderRef.current;
        if (!placeholder) return;
        window.addEventListener('resize', resize);
        const observer = new ResizeObserver(resize);
        observer.observe(placeholder);
        return () => {
            window.removeEventListener('resize', resize);
            observer.disconnect();
        };
    }, [resize]);

    // Init sizing, before the observer's first delivery. Same 0×0 skip: a remount while hidden would pin blank.
    useEffect(() => {
        const placeholder = placeholderRef.current;
        const canvas = refs.canvas.current;
        if (!placeholder || !canvas) return;
        visibleRef.current = placeholder.clientWidth > 0 && placeholder.clientHeight > 0;
        if (!visibleRef.current) return;
        drawnRef.current = undefined;
        setContext((draftCtx) => updateContextWithCanvas(draftCtx, canvas, placeholder));
    }, [refs.canvas, setContext]);

    const scheduleRedraw = useCallback(() => {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(() => {
            if (!visibleRef.current) return;
            const ctx = contextRef.current;
            const canvas = refs.canvas.current;
            if (!canvas) return;
            const freeze = freezeOf(ctx);
            const scroll: ScrollPos = {
                scrollLeft: refs.globalCache.scrollLeft,
                scrollTop: refs.globalCache.scrollTop,
            };
            const drawn = drawnRef.current;
            if (drawn?.ctx !== ctx || !scrollFrame(canvas, ctx, freeze, drawn.scroll, scroll)) {
                drawFrame(canvas, ctx, scroll, freeze);
            }
            drawnRef.current = { ctx, scroll };
        });
    }, [refs.canvas, refs.globalCache]);

    // A loaded font and a restored canvas each need a whole redraw, though neither changes the context. A font
    // that finishes loading changes the text's widths, and the font watcher drops the cached measurements before
    // it calls the grid. A canvas whose bitmap the browser dropped comes back blank.
    useEffect(() => {
        const canvas = refs.canvas.current;
        const drawWhole = () => {
            drawnRef.current = undefined;
            scheduleRedraw();
        };
        const stopWatchingFonts = watchFontFaces(drawWhole);
        canvas?.addEventListener('contextrestored', drawWhole);
        return () => {
            stopWatchingFonts();
            canvas?.removeEventListener('contextrestored', drawWhole);
        };
    }, [refs.canvas, scheduleRedraw]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: full `context` is the trigger — any change should redraw the canvas
    useEffect(() => {
        scheduleRedraw();
    }, [context, scheduleRedraw]);

    useEffect(() => {
        const { scrollListeners } = refs.globalCache;
        scrollListeners.add(scheduleRedraw);
        return () => {
            scrollListeners.delete(scheduleRedraw);
        };
    }, [refs.globalCache, scheduleRedraw]);

    useEffect(() => {
        return () => cancelAnimationFrame(rafIdRef.current);
    }, []);

    // eigen-paper: the workbook surface keeps its light rendering in dark mode
    // (globals.css convention) — canvas, headers, and every overlay painting on
    // the grid resolve theme tokens to light values.
    return (
        <div className="eigen-paper flex flex-1 flex-col min-h-0 relative bg-muted">
            <div ref={placeholderRef} className="w-full h-full block" />
            <canvas className="w-full h-full block absolute" ref={refs.canvas} aria-hidden="true" />
            <MemoizedSheetOverlay />
        </div>
    );
};
