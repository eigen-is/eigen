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
