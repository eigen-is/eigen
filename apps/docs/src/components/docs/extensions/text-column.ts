// The width of the text column a node sits in: its `[data-document]` page inside the page's padding, or null off a page.
export function textColumnWidth(inside: Node | null): number | null {
    const page = inside instanceof Element ? inside.closest('[data-document]') : null;
    if (!page) return null;
    const style = getComputedStyle(page);
    return page.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}
