// The open sheet's grid: the canvas the cells are painted on and the overlay above it. It sizes the canvas to
// its placeholder, derives the row and column geometry when the data or track sizes change, and repaints at most
// once a frame. An edit draws the frame whole; a scroll alone moves the frame drawn before and paints what came
// into view.

import type React from 'react';
import { memo, useCallback, useContext, useEffect, useRef } from 'react';
import { WorkbookContext } from '../../context';
import type { Context, Freezen, Sheet as SheetType } from '../../state';
import {
    clearMeasureTextCache,
    initFreeze,
    onMeasuredFontsLoaded,
    updateContextWithCanvas,
    updateContextWithSheetData,
} from '../../state';
import type { ScrollPos } from '../../state/render/frame';
import { drawFrame, scrollFrame } from '../../state/render/frame';
import { SheetOverlay } from '../SheetOverlay';

// What the canvas shows. When only the scroll changed since, scrollFrame moves it instead of drawing it again.
type DrawnFrame = { ctx: Context; freeze: Freezen | undefined; scroll: ScrollPos };

// ---------------------------------------------------------------------------
// Stable serialization for object-type dependency values
// ---------------------------------------------------------------------------

function useStableJson(value: unknown): string {
    const json = JSON.stringify(value ?? null);
    const ref = useRef(json);
    if (ref.current !== json) ref.current = json;
    return ref.current;
}

// ---------------------------------------------------------------------------
// Memoized overlay
// ---------------------------------------------------------------------------

const MemoizedSheetOverlay = memo(SheetOverlay);

// ---------------------------------------------------------------------------
// Sheet component
// ---------------------------------------------------------------------------

type Props = {
    sheet: SheetType;
};

export const Sheet: React.FC<Props> = ({ sheet }) => {
    const { data } = sheet;
    const placeholderRef = useRef<HTMLDivElement>(null);
    const { context, setContext, refs, settings } = useContext(WorkbookContext);

    const contextRef = useRef(context);
    contextRef.current = context;

    const dataRef = useRef(data);
    dataRef.current = data;

    const rafIdRef = useRef(0);
    // Sizing the canvas clears its bitmap, even to the same size, so whatever sizes it forgets the frame.
    const drawnRef = useRef<DrawnFrame | undefined>(undefined);
    // Latched by the 0×0 guards below so the rAF redraw skips a hidden surface.
    const visibleRef = useRef(true);

    const rowlenKey = useStableJson(sheet.config?.rowlen);
    const columnlenKey = useStableJson(sheet.config?.columnlen);
    const rowhiddenKey = useStableJson(sheet.config?.rowhidden);
    const colhiddenKey = useStableJson(sheet.config?.colhidden);

    // Data via ref so the handler identity survives edits — a rebuilt observer would re-clear the
    // canvas bitmap, and so repaint the whole grid, per keystroke.
    const resize = useCallback(() => {
        // Visibility first: a falsy-data moment must not swallow the entry that un-hides the surface.
        // 0×0 = detaching or hidden; writing it would pin the canvas blank until the next resize.
        const placeholder = placeholderRef.current;
        if (!placeholder || placeholder.clientWidth === 0 || placeholder.clientHeight === 0) {
            visibleRef.current = false;
            return;
        }
        visibleRef.current = true;

        const sheetData = dataRef.current;
        if (!sheetData) return;
        drawnRef.current = undefined;
        setContext((draftCtx) => {
            const canvas = refs.canvas.current;
            if (!canvas) return;
            if (settings.devicePixelRatio === 0) {
                draftCtx.devicePixelRatio = (typeof globalThis !== 'undefined' ? globalThis : window).devicePixelRatio;
            }
            updateContextWithSheetData(draftCtx, sheetData);
            updateContextWithCanvas(draftCtx, canvas, placeholder);
        });
    }, [refs.canvas, setContext, settings.devicePixelRatio]);

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

    // A switch derives the new sheet's geometry in its own recipe, so a changed sheet id skips the pass.
    const geometrySheetId = useRef<string | undefined>(undefined);
    // Recalculate row/col info when data or config dimensions change
    // biome-ignore lint/correctness/useExhaustiveDependencies: keys rowlen/columnlen/rowhidden/colhidden are JSON-stable derived from sheet.config; the source object refs would re-fire on identity churn
    useEffect(() => {
        if (!data) return;
        const switched = geometrySheetId.current != null && geometrySheetId.current !== sheet.id;
        geometrySheetId.current = sheet.id;
        if (switched) return;
        setContext((draftCtx) => updateContextWithSheetData(draftCtx, data));
    }, [rowlenKey, columnlenKey, rowhiddenKey, colhiddenKey, data, setContext, sheet.id]);

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

    // Recalculate freeze data when sheet or freeze config changes
    // biome-ignore lint/correctness/useExhaustiveDependencies: freeze re-init only on sheet switch / freeze config / row-col visibility change; passing the whole `context` would re-init on every cell edit
    useEffect(() => {
        initFreeze(context, refs.globalCache, context.currentSheetId);
    }, [refs.globalCache, sheet.frozen, context.currentSheetId, context.visibledatacolumn, context.visibledatarow]);

    // -----------------------------------------------------------------------
    // Canvas redraw – rAF-throttled, reads scroll from globalCache.
    //
    // Triggers:
    //   1. context changes (cell edits, selection, etc.) → useEffect
    //   2. scroll changes (native cellArea scroll) → globalCache scroll listener
    //   3. a font that finishes loading, or a canvas bitmap the browser restores → their listeners
    // All call scheduleRedraw which coalesces to one paint per frame.
    // -----------------------------------------------------------------------

    const scheduleRedraw = useCallback(() => {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(() => {
            if (!visibleRef.current) return;
            const ctx = contextRef.current;
            if (ctx.groupValuesRefreshData.length > 0) return;
            const canvas = refs.canvas.current;
            if (!canvas) return;
            const freeze = refs.globalCache.freezen?.[sheet.id];
            const scroll: ScrollPos = {
                scrollLeft: refs.globalCache.scrollLeft,
                scrollTop: refs.globalCache.scrollTop,
            };
            const drawn = drawnRef.current;
            const scrolledOnly = drawn != null && drawn.ctx === ctx && drawn.freeze === freeze;
            if (!scrolledOnly || !scrollFrame(canvas, ctx, freeze, drawn.scroll, scroll)) {
                drawFrame(canvas, ctx, scroll, freeze);
            }
            drawnRef.current = { ctx, freeze, scroll };
        });
    }, [refs.canvas, refs.globalCache, sheet.id]);

    // Neither changes the context: a web font that finishes loading changes the text's widths, so the
    // measurements go too, and a canvas whose bitmap the browser dropped comes back blank. WebKit fires no
    // loadingdone for the slices a canvas draws, so the measure's own loads report too.
    useEffect(() => {
        const canvas = refs.canvas.current;
        const drawWhole = () => {
            drawnRef.current = undefined;
            scheduleRedraw();
        };
        const onFontsLoaded = () => {
            clearMeasureTextCache();
            drawWhole();
        };
        document.fonts.addEventListener('loadingdone', onFontsLoaded);
        const stopMeasuredFonts = onMeasuredFontsLoaded(onFontsLoaded);
        canvas?.addEventListener('contextrestored', drawWhole);
        return () => {
            document.fonts.removeEventListener('loadingdone', onFontsLoaded);
            stopMeasuredFonts();
            canvas?.removeEventListener('contextrestored', drawWhole);
        };
    }, [refs.canvas, scheduleRedraw]);

    // Redraw on context changes (non-scroll: cell edits, selection, etc.)
    // biome-ignore lint/correctness/useExhaustiveDependencies: full `context` is the trigger — any change should redraw the canvas
    useEffect(() => {
        scheduleRedraw();
    }, [context, scheduleRedraw]);

    // Redraw on scroll changes (from globalCache listener, bypasses React)
    useEffect(() => {
        const { scrollListeners } = refs.globalCache;
        scrollListeners.add(scheduleRedraw);
        return () => {
            scrollListeners.delete(scheduleRedraw);
        };
    }, [refs.globalCache, scheduleRedraw]);

    // Cancel pending rAF on unmount
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
