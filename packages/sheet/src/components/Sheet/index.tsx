import type React from 'react';
import { memo, useCallback, useContext, useEffect, useRef } from 'react';
import { WorkbookContext } from '../../context';
import {
    Canvas,
    type Context,
    type Freezen,
    type FreezenAxisData,
    initFreeze,
    type Sheet as SheetType,
    updateContextWithCanvas,
    updateContextWithSheetData,
} from '../../state';
import { SheetOverlay } from '../SheetOverlay';

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------

type ScrollPos = { scrollLeft: number; scrollTop: number };

function drawFrozenBoth(
    tc: Canvas,
    ctx: Context,
    scroll: ScrollPos,
    horizontalData: FreezenAxisData,
    verticalData: FreezenAxisData,
) {
    const vOffset = verticalData.pos - verticalData.scroll;
    const hOffset = horizontalData.pos - horizontalData.scroll;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: scroll.scrollTop + hOffset,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
        offsetTop: hOffset + ctx.columnHeaderHeight,
        clear: true,
    });
    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: horizontalData.scroll,
        drawHeight: horizontalData.pos,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
    });
    tc.drawMain({
        scrollWidth: verticalData.scroll,
        scrollHeight: scroll.scrollTop + hOffset,
        drawWidth: verticalData.pos,
        offsetTop: hOffset + ctx.columnHeaderHeight,
    });
    tc.drawMain({
        scrollWidth: verticalData.scroll,
        scrollHeight: horizontalData.scroll,
        drawWidth: verticalData.pos,
        drawHeight: horizontalData.pos,
    });

    tc.drawColumnHeader(scroll.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
    tc.drawColumnHeader(verticalData.scroll, verticalData.pos);
    tc.drawRowHeader(scroll.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
    tc.drawRowHeader(horizontalData.scroll, horizontalData.pos);
    tc.drawFreezeLine({
        horizontalTop: hOffset + ctx.columnHeaderHeight - 2,
        verticalLeft: vOffset + ctx.rowHeaderWidth - 2,
    });
}

function drawFrozenHorizontal(tc: Canvas, ctx: Context, scroll: ScrollPos, horizontalData: FreezenAxisData) {
    const hOffset = horizontalData.pos - horizontalData.scroll;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft,
        scrollHeight: scroll.scrollTop + hOffset,
        offsetTop: hOffset + ctx.columnHeaderHeight,
        clear: true,
    });
    tc.drawMain({
        scrollWidth: scroll.scrollLeft,
        scrollHeight: horizontalData.scroll,
        drawHeight: horizontalData.pos,
    });

    tc.drawColumnHeader(scroll.scrollLeft);
    tc.drawRowHeader(scroll.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
    tc.drawRowHeader(horizontalData.scroll, horizontalData.pos);
    tc.drawFreezeLine({ horizontalTop: hOffset + ctx.columnHeaderHeight - 2 });
}

function drawFrozenVertical(tc: Canvas, ctx: Context, scroll: ScrollPos, verticalData: FreezenAxisData) {
    const vOffset = verticalData.pos - verticalData.scroll;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: scroll.scrollTop,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
    });
    tc.drawMain({
        scrollWidth: verticalData.scroll,
        scrollHeight: scroll.scrollTop,
        drawWidth: verticalData.pos,
    });

    tc.drawRowHeader(scroll.scrollTop);
    tc.drawColumnHeader(scroll.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
    tc.drawColumnHeader(verticalData.scroll, verticalData.pos);
    tc.drawFreezeLine({ verticalLeft: vOffset + ctx.rowHeaderWidth - 2 });
}

function drawSheet(canvasEl: HTMLCanvasElement, ctx: Context, scroll: ScrollPos, freeze: Freezen | undefined) {
    const tc = new Canvas(canvasEl, ctx);
    const horizontalData = freeze?.horizontal?.freezenhorizontaldata;
    const verticalData = freeze?.vertical?.freezenverticaldata;

    if (horizontalData && verticalData) {
        drawFrozenBoth(tc, ctx, scroll, horizontalData, verticalData);
    } else if (horizontalData) {
        drawFrozenHorizontal(tc, ctx, scroll, horizontalData);
    } else if (verticalData) {
        drawFrozenVertical(tc, ctx, scroll, verticalData);
    } else {
        tc.drawMain({ scrollWidth: scroll.scrollLeft, scrollHeight: scroll.scrollTop, clear: true });
        tc.drawColumnHeader(scroll.scrollLeft);
        tc.drawRowHeader(scroll.scrollTop);
    }
}

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

    const rowlenKey = useStableJson(context.config?.rowlen);
    const columnlenKey = useStableJson(context.config?.columnlen);
    const rowhiddenKey = useStableJson(context.config?.rowhidden);
    const colhiddenKey = useStableJson(context.config?.colhidden);

    // Resize handler. Reads the sheet data through a ref so its identity survives every edit:
    // re-observing re-measures immediately, and updateContextWithCanvas' canvas.width write clears
    // the bitmap, so an observer rebuilt per keystroke would repaint the whole grid per keystroke.
    const resize = useCallback(() => {
        const sheetData = dataRef.current;
        if (!sheetData) return;
        // Nothing measurable yet: React detaches the ref during unmount before this effect's
        // cleanup disconnects the observer, and removing a watched node fires it. A hidden
        // container likewise measures 0×0 — writing that pins the canvas blank until the next
        // resize, so wait for the real box the observer reports on un-hide.
        const placeholder = placeholderRef.current;
        if (!placeholder || placeholder.clientWidth === 0 || placeholder.clientHeight === 0) return;
        setContext((draftCtx) => {
            if (settings.devicePixelRatio === 0) {
                draftCtx.devicePixelRatio = (typeof globalThis !== 'undefined' ? globalThis : window).devicePixelRatio;
            }
            updateContextWithSheetData(draftCtx, sheetData);
            updateContextWithCanvas(draftCtx, refs.canvas.current!, placeholder);
        });
    }, [refs.canvas, setContext, settings.devicePixelRatio]);

    // Window resize also covers devicePixelRatio changes, which leave the box alone; the observer
    // covers container-only resizes (side panels, layout switches, un-hiding). No feedback loop:
    // the placeholder is sized by its flex parent, canvas and overlay are absolute.
    useEffect(() => {
        window.addEventListener('resize', resize);
        const observer = new ResizeObserver(resize);
        observer.observe(placeholderRef.current!);
        return () => {
            window.removeEventListener('resize', resize);
            observer.disconnect();
        };
    }, [resize]);

    // Recalculate row/col info when data or config dimensions change
    // biome-ignore lint/correctness/useExhaustiveDependencies: keys rowlen/columnlen/rowhidden/colhidden are JSON-stable derived from context.config; the source object refs would re-fire on identity churn
    useEffect(() => {
        if (!data) return;
        setContext((draftCtx) => updateContextWithSheetData(draftCtx, data));
    }, [rowlenKey, columnlenKey, rowhiddenKey, colhiddenKey, data, setContext]);

    // Init canvas sizing
    useEffect(() => {
        setContext((draftCtx) => updateContextWithCanvas(draftCtx, refs.canvas.current!, placeholderRef.current!));
    }, [refs.canvas, setContext]);

    // Recalculate freeze data when sheet or freeze config changes
    // biome-ignore lint/correctness/useExhaustiveDependencies: freeze re-init only on sheet switch / freeze config / row-col visibility change; passing the whole `context` would re-init on every cell edit
    useEffect(() => {
        initFreeze(context, refs.globalCache, context.currentSheetId);
    }, [refs.globalCache, sheet.frozen, context.currentSheetId, context.visibledatacolumn, context.visibledatarow]);

    // -----------------------------------------------------------------------
    // Canvas redraw – rAF-throttled, reads scroll from globalCache.
    //
    // Two triggers:
    //   1. context changes (cell edits, selection, etc.) → useEffect
    //   2. scroll changes (native cellArea scroll) → globalCache scroll listener
    // Both call scheduleRedraw which coalesces to one paint per frame.
    // -----------------------------------------------------------------------

    const scheduleRedraw = useCallback(() => {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = requestAnimationFrame(() => {
            const ctx = contextRef.current;
            if (ctx.groupValuesRefreshData.length > 0) return;
            if (!refs.canvas.current) return;
            const freeze = refs.globalCache.freezen?.[sheet.id!];
            const scroll: ScrollPos = {
                scrollLeft: refs.globalCache.scrollLeft,
                scrollTop: refs.globalCache.scrollTop,
            };
            drawSheet(refs.canvas.current, ctx, scroll, freeze);
        });
    }, [refs.canvas, refs.globalCache, sheet.id]);

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
