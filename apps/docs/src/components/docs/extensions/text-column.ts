// The width inside an element's padding, or null for one not laid out.
export function contentWidth(element: Element): number | null {
    const style = getComputedStyle(element);
    const width = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    return width > 0 ? width : null;
}

// The width of the text column a node sits in: its `[data-document]` page inside the page's padding, or null with no
// page laid out. A band's editor in the side panel sits off the page and prints in its column, so it measures the page.
export function textColumnWidth(inside: Node | null): number | null {
    if (!(inside instanceof Element)) return null;
    const page = inside.closest('[data-document]') ?? inside.ownerDocument.querySelector('[data-document]');
    return page ? contentWidth(page) : null;
}
