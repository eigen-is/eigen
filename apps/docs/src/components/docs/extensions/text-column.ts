// The page's geometry in the Docs editor: the text column's width as laid out on screen, which caps a figure in the
// flow, the scale the page draws at, which turns a pointer's screen px into the page px the doc stores, and the paper
// and column of the page map, which a page-less doc's wide content and a new chart are measured against. Node views,
// menus and editor plugins read them.

import type { Editor } from '@tiptap/core';
import { pageColumnWidth } from '@workspace/lib/docs/eigendoc';

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

// The page map's paper width and text column in page px, never the screen's, as every stored width is page px. A
// page-less doc draws its text in the reader's own column, so its caps read these instead.
export function pageWidths(editor: Editor): { paper: number; column: number; pageless: boolean } {
    const page = editor.storage.positionedFigures.page();
    return { paper: page.width, column: pageColumnWidth(page), pageless: page.pageless };
}
