// The page's geometry as the Docs editor lays it out on screen: the text column's width, which caps a figure in the
// flow, and the scale the page draws at, which turns a pointer's screen px into the page px the doc stores. Node
// views and editor plugins read them.

// The width inside an element's padding, or null for one not laid out.
export function contentWidth(element: Element): number | null {
    const style = getComputedStyle(element);
    const width = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    return width > 0 ? width : null;
}

// The width of the text column a node sits in: its `[data-document]` page inside the page's padding, or null off a
// page or on one not laid out.
export function textColumnWidth(inside: Node | null): number | null {
    const page = inside instanceof Element ? inside.closest('[data-document]') : null;
    return page ? contentWidth(page) : null;
}

// The page draws scaled below its width, and a page px is a screen px divided by this scale. `inside` is any element
// on the page, laid out at the page's own width; one not laid out reads 1.
export function pageScale(inside: HTMLElement): number {
    const { offsetWidth } = inside;
    return offsetWidth > 0 ? inside.getBoundingClientRect().width / offsetWidth : 1;
}
