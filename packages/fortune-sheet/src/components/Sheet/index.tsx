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
import WorkbookContext from "../../context";
import SheetOverlay from "../SheetOverlay";

// ---------------------------------------------------------------------------
// Canvas drawing helpers (extracted from the old monolithic useEffect)
// ---------------------------------------------------------------------------

function drawFrozenBoth(
    tc: Canvas,
    ctx: Context,
    horizontalData: any[],
    verticalData: any[]
) {
  const [hPx, , hScrollTop] = horizontalData;
  const [vPx, , vScrollWidth] = verticalData;
  const vOffset = vPx - vScrollWidth;
  const hOffset = hPx - hScrollTop;

  // main (bottom-right)
  tc.drawMain({
    scrollWidth: ctx.scrollLeft + vOffset,
    scrollHeight: ctx.scrollTop + hOffset,
    offsetLeft: vOffset + ctx.rowHeaderWidth,
    offsetTop: hOffset + ctx.columnHeaderHeight,
    clear: true,
  });
  // top-right
  tc.drawMain({
    scrollWidth: ctx.scrollLeft + vOffset,
    scrollHeight: hScrollTop,
    drawHeight: hPx,
    offsetLeft: vOffset + ctx.rowHeaderWidth,
  });
  // bottom-left
  tc.drawMain({
    scrollWidth: vScrollWidth,
    scrollHeight: ctx.scrollTop + hOffset,
    drawWidth: vPx,
    offsetTop: hOffset + ctx.columnHeaderHeight,
  });
  // top-left
  tc.drawMain({
    scrollWidth: vScrollWidth,
    scrollHeight: hScrollTop,
    drawWidth: vPx,
    drawHeight: hPx,
  });

  tc.drawColumnHeader(ctx.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
  tc.drawColumnHeader(vScrollWidth, vPx);
  tc.drawRowHeader(ctx.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
  tc.drawRowHeader(hScrollTop, hPx);
  tc.drawFreezeLine({
    horizontalTop: hOffset + ctx.columnHeaderHeight - 2,
    verticalLeft: vOffset + ctx.rowHeaderWidth - 2,
  });
}

function drawFrozenHorizontal(tc: Canvas, ctx: Context, horizontalData: any[]) {
  const [hPx, , hScrollTop] = horizontalData;
  const hOffset = hPx - hScrollTop;

  tc.drawMain({
    scrollWidth: ctx.scrollLeft,
    scrollHeight: ctx.scrollTop + hOffset,
    offsetTop: hOffset + ctx.columnHeaderHeight,
    clear: true,
  });
  tc.drawMain({
    scrollWidth: ctx.scrollLeft,
    scrollHeight: hScrollTop,
    drawHeight: hPx,
  });

  tc.drawColumnHeader(ctx.scrollLeft);
  tc.drawRowHeader(ctx.scrollTop + hOffset, undefined, hOffset + ctx.columnHeaderHeight);
  tc.drawRowHeader(hScrollTop, hPx);
  tc.drawFreezeLine({horizontalTop: hOffset + ctx.columnHeaderHeight - 2});
}

function drawFrozenVertical(tc: Canvas, ctx: Context, verticalData: any[]) {
  const [vPx, , vScrollWidth] = verticalData;
  const vOffset = vPx - vScrollWidth;

  tc.drawMain({
    scrollWidth: ctx.scrollLeft + vOffset,
    scrollHeight: ctx.scrollTop,
    offsetLeft: vOffset + ctx.rowHeaderWidth,
  });
  tc.drawMain({
    scrollWidth: vScrollWidth,
    scrollHeight: ctx.scrollTop,
    drawWidth: vPx,
  });

  tc.drawRowHeader(ctx.scrollTop);
  tc.drawColumnHeader(ctx.scrollLeft + vOffset, undefined, vOffset + ctx.rowHeaderWidth);
  tc.drawColumnHeader(vScrollWidth, vPx);
  tc.drawFreezeLine({verticalLeft: vOffset + ctx.rowHeaderWidth - 2});
}

function drawSheet(
    canvasEl: HTMLCanvasElement,
    ctx: Context,
    freeze: Freezen | undefined
) {
  const tc = new Canvas(canvasEl, ctx);
  const horizontalData = freeze?.horizontal?.freezenhorizontaldata;
  const verticalData = freeze?.vertical?.freezenverticaldata;

  if (horizontalData && verticalData) {
    drawFrozenBoth(tc, ctx, horizontalData, verticalData);
  } else if (horizontalData) {
    drawFrozenHorizontal(tc, ctx, horizontalData);
  } else if (verticalData) {
    drawFrozenVertical(tc, ctx, verticalData);
  } else {
    tc.drawMain({scrollWidth: ctx.scrollLeft, scrollHeight: ctx.scrollTop, clear: true});
    tc.drawColumnHeader(ctx.scrollLeft);
    tc.drawRowHeader(ctx.scrollTop);
  }
}

// ---------------------------------------------------------------------------
// Stable serialization for object-type dependency values so effects only
// re-fire when the actual values change, not on every immer-produced reference.
// ---------------------------------------------------------------------------

function useStableJson(value: unknown): string {
  const json = JSON.stringify(value ?? null);
  const ref = useRef(json);
  if (ref.current !== json) ref.current = json;
  return ref.current;
}

// ---------------------------------------------------------------------------
// Memoized overlay – prevents re-render when only the parent Sheet re-renders
// due to a sheet prop change without a context change.
// ---------------------------------------------------------------------------

const MemoizedSheetOverlay = memo(SheetOverlay);

// ---------------------------------------------------------------------------
// Sheet component
// ---------------------------------------------------------------------------

type Props = {
  sheet: SheetType;
};

const Sheet: React.FC<Props> = ({ sheet }) => {
  const { data } = sheet;
  const containerRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const { context, setContext, refs, settings } = useContext(WorkbookContext);

  // Keep a mutable ref to the latest context so the rAF callback always
  // reads the most recent snapshot without needing to re-schedule.
  const contextRef = useRef(context);
  contextRef.current = context;

  const rafIdRef = useRef(0);

  // Stable keys for object-typed config values so effects 2 won't re-fire
  // on every unrelated context change (immer produces new object refs).
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
  // Canvas redraw – throttled to one repaint per animation frame.
  //
  // WHY THIS MATTERS:
  //   The old code used `context` (the entire app state object) as a useEffect
  //   dependency. Because immer produces a new object reference for ANY state
  //   mutation, every single change – scroll, selection, cell edit, formula
  //   refresh – triggered a synchronous full canvas redraw. On scroll the
  //   problem was doubled: handleGlobalWheel sets the scrollbar DOM value,
  //   then the scrollbar's onScroll handler sets context.scrollTop again,
  //   causing TWO state updates → TWO redraws per wheel tick.
  //
  //   By scheduling the actual draw via requestAnimationFrame and always
  //   reading from contextRef.current (the latest snapshot), multiple rapid
  //   context changes within one frame collapse into a single draw call.
  // -----------------------------------------------------------------------

  const scheduleRedraw = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      const ctx = contextRef.current;
      if (ctx.groupValuesRefreshData.length > 0) return;
      if (!refs.canvas.current) return;
      const freeze = refs.globalCache.freezen?.[sheet.id!];
      drawSheet(refs.canvas.current, ctx, freeze);
    });
  }, [refs.canvas, refs.globalCache, sheet.id]);

  // Trigger a redraw whenever context changes (same semantic as before),
  // but the actual paint is coalesced by the rAF above.
  useEffect(() => {
    scheduleRedraw();
  }, [context, scheduleRedraw]);

  // Cancel pending rAF on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(rafIdRef.current);
  }, []);

  // Wheel handler
  const onWheel = useCallback(
    (e: WheelEvent) => {
      setContext((draftCtx) => {
        handleGlobalWheel(draftCtx, e, refs.globalCache, refs.scrollbarX.current!, refs.scrollbarY.current!);
      });
      // handleGlobalWheel already calls e.preventDefault() internally
    },
    [refs.globalCache, refs.scrollbarX, refs.scrollbarY, setContext]
  );

  useEffect(() => {
    const container = containerRef.current;
    container?.addEventListener("wheel", onWheel, {passive: false});
    return () => container?.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  return (
    <div ref={containerRef} className="flex flex-1 flex-col min-h-0 relative">
      <div ref={placeholderRef} className="w-full h-full block" />
      <canvas
        className="w-full h-full block absolute"
        ref={refs.canvas}
        aria-hidden="true"
      />
      <MemoizedSheetOverlay/>
    </div>
  );
};

export default Sheet;
