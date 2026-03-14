import React, {memo, useCallback, useContext, useEffect, useRef} from "react";
import {
    Canvas,
    Context,
    Freezen,
    handleGlobalWheel,
    initFreeze,
    Sheet as SheetType,
    updateContextWithCanvas,
    updateContextWithSheetData,
} from "../../core";
import {WorkbookContext} from "../../context";
import {SheetOverlay} from "../SheetOverlay";

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------

type ScrollPos = { scrollLeft: number; scrollTop: number };

function drawFrozenBoth(
    tc: Canvas,
    ctx: Context,
    scroll: ScrollPos,
    horizontalData: any[],
    verticalData: any[]
) {
    const [hPx, , hScrollTop] = horizontalData;
    const [vPx, , vScrollWidth] = verticalData;
    const vOffset = vPx - vScrollWidth;
    const hOffset = hPx - hScrollTop;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: scroll.scrollTop + hOffset,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
        offsetTop: hOffset + ctx.columnHeaderHeight,
        clear: true,
    });
    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: hScrollTop,
        drawHeight: hPx,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
    });
    tc.drawMain({
        scrollWidth: vScrollWidth,
        scrollHeight: scroll.scrollTop + hOffset,
        drawWidth: vPx,
        offsetTop: hOffset + ctx.columnHeaderHeight,
    });
    tc.drawMain({
        scrollWidth: vScrollWidth,
        scrollHeight: hScrollTop,
        drawWidth: vPx,
        drawHeight: hPx,
    });

    tc.drawColumnHeader(scroll.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
    tc.drawColumnHeader(vScrollWidth, vPx);
    tc.drawRowHeader(scroll.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
    tc.drawRowHeader(hScrollTop, hPx);
    tc.drawFreezeLine({
        horizontalTop: hOffset + ctx.columnHeaderHeight - 2,
        verticalLeft: vOffset + ctx.rowHeaderWidth - 2,
    });
}

function drawFrozenHorizontal(tc: Canvas, ctx: Context, scroll: ScrollPos, horizontalData: any[]) {
    const [hPx, , hScrollTop] = horizontalData;
    const hOffset = hPx - hScrollTop;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft,
        scrollHeight: scroll.scrollTop + hOffset,
        offsetTop: hOffset + ctx.columnHeaderHeight,
        clear: true,
    });
    tc.drawMain({
        scrollWidth: scroll.scrollLeft,
        scrollHeight: hScrollTop,
        drawHeight: hPx,
    });

    tc.drawColumnHeader(scroll.scrollLeft);
    tc.drawRowHeader(scroll.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
    tc.drawRowHeader(hScrollTop, hPx);
    tc.drawFreezeLine({horizontalTop: hOffset + ctx.columnHeaderHeight - 2});
}

function drawFrozenVertical(tc: Canvas, ctx: Context, scroll: ScrollPos, verticalData: any[]) {
    const [vPx, , vScrollWidth] = verticalData;
    const vOffset = vPx - vScrollWidth;

    tc.drawMain({
        scrollWidth: scroll.scrollLeft + vOffset,
        scrollHeight: scroll.scrollTop,
        offsetLeft: vOffset + ctx.rowHeaderWidth,
    });
    tc.drawMain({
        scrollWidth: vScrollWidth,
        scrollHeight: scroll.scrollTop,
        drawWidth: vPx,
    });

    tc.drawRowHeader(scroll.scrollTop);
    tc.drawColumnHeader(scroll.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
    tc.drawColumnHeader(vScrollWidth, vPx);
    tc.drawFreezeLine({verticalLeft: vOffset + ctx.rowHeaderWidth - 2});
}

function drawSheet(
    canvasEl: HTMLCanvasElement,
    ctx: Context,
    scroll: ScrollPos,
    freeze: Freezen | undefined
) {
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
        tc.drawMain({scrollWidth: scroll.scrollLeft, scrollHeight: scroll.scrollTop, clear: true});
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

export const Sheet: React.FC<Props> = ({sheet}) => {
    const {data} = sheet;
    const containerRef = useRef<HTMLDivElement>(null);
    const placeholderRef = useRef<HTMLDivElement>(null);
    const {context, setContext, refs, settings} = useContext(WorkbookContext);

    const contextRef = useRef(context);
    contextRef.current = context;

    const rafIdRef = useRef(0);

    const rowlenKey = useStableJson(context.config?.rowlen);
    const columnlenKey = useStableJson(context.config?.columnlen);
    const rowhiddenKey = useStableJson(context.config?.rowhidden);
    const colhiddenKey = useStableJson(context.config?.colhidden);

    // Resize handler
    useEffect(() => {
        function resize() {
            if (!data) return;
            setContext((draftCtx) => {
                if (settings.devicePixelRatio === 0) {
                    draftCtx.devicePixelRatio = (
                        typeof globalThis !== "undefined" ? globalThis : window
                    ).devicePixelRatio;
                }
                updateContextWithSheetData(draftCtx, data);
                updateContextWithCanvas(draftCtx, refs.canvas.current!, placeholderRef.current!);
            });
        }

        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, [data, refs.canvas, setContext, settings.devicePixelRatio]);

    // Recalculate row/col info when data or config dimensions change
    useEffect(() => {
        if (!data) return;
        setContext((draftCtx) => updateContextWithSheetData(draftCtx, data));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rowlenKey, columnlenKey, rowhiddenKey, colhiddenKey, data, context.zoomRatio, setContext]);

    // Init canvas sizing
    useEffect(() => {
        setContext((draftCtx) =>
            updateContextWithCanvas(draftCtx, refs.canvas.current!, placeholderRef.current!)
        );
    }, [refs.canvas, setContext, context.rowHeaderWidth, context.columnHeaderHeight, context.devicePixelRatio]);

    // Recalculate freeze data when sheet or freeze config changes
    useEffect(() => {
        initFreeze(context, refs.globalCache, context.currentSheetId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refs.globalCache, sheet.frozen, context.currentSheetId, context.visibledatacolumn, context.visibledatarow]);

    // -----------------------------------------------------------------------
    // Canvas redraw – rAF-throttled, reads scroll from globalCache.
    //
    // Two triggers:
    //   1. context changes (cell edits, selection, zoom, etc.) → useEffect
    //   2. scroll changes (wheel/scrollbar) → globalCache scroll listener
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
    useEffect(() => {
        scheduleRedraw();
    }, [context, scheduleRedraw]);

    // Redraw on scroll changes (from globalCache listener, bypasses React)
    useEffect(() => {
        const {scrollListeners} = refs.globalCache;
        scrollListeners.add(scheduleRedraw);
        return () => {
            scrollListeners.delete(scheduleRedraw);
        };
    }, [refs.globalCache, scheduleRedraw]);

    // Cancel pending rAF on unmount
    useEffect(() => {
        return () => cancelAnimationFrame(rafIdRef.current);
    }, []);

    // Wheel handler — reads from contextRef, writes to scrollbar DOM + cache.
    // Does NOT call setContext. Scroll state flows through globalCache.
    const onWheel = useCallback(
        (e: WheelEvent) => {
            handleGlobalWheel(
                contextRef.current,
                e,
                refs.globalCache,
                refs.scrollbarX.current!,
                refs.scrollbarY.current!
            );
        },
        [refs.globalCache, refs.scrollbarX, refs.scrollbarY]
    );

    useEffect(() => {
        const container = containerRef.current;
        container?.addEventListener("wheel", onWheel, {passive: false});
        return () => container?.removeEventListener("wheel", onWheel);
    }, [onWheel]);

    return (
        <div ref={containerRef} className="flex flex-1 flex-col min-h-0 relative">
            <div ref={placeholderRef} className="w-full h-full block"/>
            <canvas
                className="w-full h-full block absolute"
                ref={refs.canvas}
                aria-hidden="true"
            />
            <MemoizedSheetOverlay/>
        </div>
    );
};

