// Anchor geometry for popups that follow a cell but render outside the grid.
// The body overlay layer is a sticky 0×0 anchor at the cell area's scrollport
// origin, and OverlayRegion translates its content by the pane's scroll — so an
// overlay child at sheet-content coordinates paints at (content − pane scroll)
// from that origin. A portaled dialog is position:fixed and needs the same
// point in viewport coordinates instead.

export type ViewportPoint = {
    left: number;
    top: number;
};

export type OverlayAnchor = {
    // Sheet-content coordinates, as ctx.visibledatacolumn / visibledatarow give them.
    contentLeft: number;
    contentTop: number;
    // Client rect origin of the cell area — where the overlay layer sticks. It already
    // excludes the row header and column header, which sit outside that element.
    areaLeft: number;
    areaTop: number;
    // The anchor pane's freeze-pinned scroll per axis; null follows the scroll bus.
    fixedLeft: number | null;
    fixedTop: number | null;
    scrollLeft: number;
    scrollTop: number;
};

export function overlayAnchorToViewport(anchor: OverlayAnchor): ViewportPoint {
    return {
        left: anchor.areaLeft + anchor.contentLeft - (anchor.fixedLeft ?? anchor.scrollLeft),
        top: anchor.areaTop + anchor.contentTop - (anchor.fixedTop ?? anchor.scrollTop),
    };
}

// Distance a clamped popup keeps from the viewport edges.
export const VIEWPORT_MARGIN = 8;

// Shift a popup of this size back on screen. Math.max last: one larger than the
// viewport pins to the top-left margin rather than off the opposite edge.
export function clampToViewport(
    point: ViewportPoint,
    size: { width: number; height: number },
    viewport: { width: number; height: number },
    margin: number = VIEWPORT_MARGIN,
): ViewportPoint {
    return {
        left: Math.max(margin, Math.min(point.left, viewport.width - size.width - margin)),
        top: Math.max(margin, Math.min(point.top, viewport.height - size.height - margin)),
    };
}
