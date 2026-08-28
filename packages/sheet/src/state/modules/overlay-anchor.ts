// Anchor geometry for popups that follow a cell but render outside the grid.
// The body overlay layer is a sticky 0×0 anchor at the cell area's scrollport
// origin, and OverlayRegion translates its content by the pane's scroll — so an
// overlay child at sheet-content coordinates paints at (content − pane scroll)
// from that origin. A portaled dialog is position:fixed and needs the same
// point in viewport coordinates instead.
//
// content* is in sheet-content coordinates, as ctx.visibledatacolumn / visibledatarow
// give them. area* is the client rect origin of the cell area — where the overlay layer
// sticks; it already excludes the row and column headers, which sit outside that element.
// fixed* is the anchor pane's freeze-pinned scroll per axis; null follows the scroll bus.

export type ViewportPoint = {
    left: number;
    top: number;
};

export function overlayAnchorToViewport(
    contentLeft: number,
    contentTop: number,
    areaLeft: number,
    areaTop: number,
    fixedLeft: number | null,
    fixedTop: number | null,
    scrollLeft: number,
    scrollTop: number,
): ViewportPoint {
    return {
        left: areaLeft + contentLeft - (fixedLeft ?? scrollLeft),
        top: areaTop + contentTop - (fixedTop ?? scrollTop),
    };
}
