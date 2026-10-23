import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { ClipboardBox } from '@workspace/lib/clipboard';
import {
    buildChartClipboardItem,
    buildImageClipboardItem,
    buildTextClipboardItem,
    clipboardTextItemHasContent,
    readClipboardBox,
    writeEigenClipboard,
} from '@workspace/lib/clipboard';
import { getFontName, readCssFontSize } from '@workspace/lib/constants/fonts';
import {
    CHART_DEFAULT_SIZE,
    ITALIC_HEADING_LEVELS,
    ITALIC_HEADING_SELECTOR,
    PAGE_NUMBER_TEXT,
    readChartAttrs,
    readEquation,
    type TitleType,
} from '@workspace/lib/docs/eigendoc';
import type {
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_IMAGE_BOX, oneOf, TEXT_ALIGNS } from '@workspace/lib/vector';
import { textOutsideNotes } from './extensions/footnote';

// The clipboard box for a figure at `pos`. Figures store WIDTH ONLY on purpose (the doc reflows and
// the height must follow the image), but the wire carries both dims, so measure the rendered <img>.
// clientWidth, not getBoundingClientRect: layout px are the space the stored width lives in (the
// identity mapping in extensions/figure.tsx), while a narrow viewport puts a `scale()` on the page.
// Height comes from the image's own intrinsic ratio rather than its laid-out height, so a mid-load
// layout can't skew it. Nothing measurable (node view not mounted, image not loaded) → the stored
// width at the shared default ratio, the single fallback.
function figureClipboardBox(view: EditorView, pos: number, storedWidth: unknown): ClipboardBox {
    const dom = view.nodeDOM(pos);
    const img = dom instanceof HTMLElement ? dom.querySelector('img') : null;
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
        const ratio =
            img.naturalWidth > 0 && img.naturalHeight > 0
                ? img.naturalWidth / img.naturalHeight
                : img.clientWidth / img.clientHeight;
        return { width: img.clientWidth, height: img.clientWidth / ratio };
    }
    const width = typeof storedWidth === 'number' && storedWidth > 0 ? storedWidth : DEFAULT_IMAGE_BOX.width;
    return { width, height: (width * DEFAULT_IMAGE_BOX.height) / DEFAULT_IMAGE_BOX.width };
}

// The rendered box of the text blocks `from`..`to` spans: the widest, and their heights summed.
function textRunBox(view: EditorView, from: number, to: number): ClipboardBox {
    const box = { width: 0, height: 0 };
    view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
            box.width = Math.max(box.width, dom.clientWidth);
            box.height += dom.clientHeight;
        }
        return false;
    });
    return box;
}

// The eigen items a copy of `from`..`to` writes, in document order: an image item per figure whose file
// resolves, a chart item per chart with inline data, and the text between them as a text item, a line per
// paragraph, an equation as its text, a page number as its # and a footnote as nothing. None → no items, and the
// copy is ProseMirror's own.
function copiedClipboardItems(
    view: EditorView,
    from: number,
    to: number,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem[] {
    const items: EigenClipboardItem[] = [];
    let runFrom = from;
    const pushText = (runTo: number) => {
        const text = textOutsideNotes(view.state.doc, runFrom, runTo, '\n', '', (leaf) => {
            if (leaf.type.name === 'equation') return readEquation(leaf.attrs).text;
            return leaf.type.name === 'pageNumber' ? PAGE_NUMBER_TEXT : '';
        }).trim();
        if (text) items.push(buildTextClipboardItem({ text, box: textRunBox(view, runFrom, runTo) }));
    };
    // A note's text and images are no part of the sentence around its reference: a paste elsewhere places them as one.
    const push = (pos: number, size: number, item: EigenClipboardItem) => {
        pushText(pos);
        runFrom = pos + size;
        items.push(item);
    };
    view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'footnote') return false;
        if (node.type.name === 'chart') {
            const attrs = readChartAttrs(node.attrs);
            const { spec, width, height } = attrs;
            const box = { width: width ?? CHART_DEFAULT_SIZE.width, height: height ?? CHART_DEFAULT_SIZE.height };
            const item = spec ? buildChartClipboardItem({ spec, box, look: attrs }) : null;
            if (item) push(pos, node.nodeSize, item);
            return;
        }
        if (node.type.name !== 'figure' || !node.attrs.mediaName) return;
        const mediaPath = resolveMediaPath(node.attrs.mediaName);
        if (!mediaPath) return;
        push(
            pos,
            node.nodeSize,
            buildImageClipboardItem({
                mediaName: node.attrs.mediaName,
                source: mediaPath,
                box: figureClipboardBox(view, pos, node.attrs.width),
                caption: node.attrs.caption || undefined,
            }),
        );
    });
    if (items.length > 0) pushText(to);
    return items;
}

// A copy or cut with eigen items writes them beside ProseMirror's own HTML and text, and a cut deletes the
// selection as ProseMirror's handler would. Bound in handleDOMEvents, so it runs before that handler, whose
// cut deletes the selection before any later listener reads it. Google Docs and Word read a run by its look, so an
// italic mark in an italic heading is written upright, and a title's and a subtitle's look on its p.
export function writeDocsClipboard(
    view: EditorView,
    event: ClipboardEvent,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): boolean {
    const { selection } = view.state;
    const cut = event.type === 'cut';
    if (selection.empty || !event.clipboardData || (cut && !view.editable)) return false;
    const items = copiedClipboardItems(view, selection.from, selection.to, resolveMediaPath);
    // The first title and subtitle in the selection: a node's own look is the same for every node of its type.
    const titles = new Map<TitleType, number>();
    let upright = false;
    view.state.doc.nodesBetween(selection.from, selection.to, (node, pos, parent) => {
        if (node.type.name === 'title' || node.type.name === 'subtitle') {
            if (!titles.has(node.type.name)) titles.set(node.type.name, pos);
        } else if (
            parent?.type.name === 'heading' &&
            ITALIC_HEADING_LEVELS.has(parent.attrs['level']) &&
            node.marks.some((mark) => mark.type.name === 'italic')
        )
            upright = true;
    });
    if (items.length === 0 && titles.size === 0 && !upright) return false;

    const { dom, text } = view.serializeForClipboard(selection.content());
    for (const heading of dom.querySelectorAll(ITALIC_HEADING_SELECTOR)) {
        for (const em of heading.querySelectorAll<HTMLElement>('em')) em.style.fontStyle = 'normal';
    }
    for (const [type, pos] of titles) {
        const drawn = view.nodeDOM(pos);
        if (!(drawn instanceof HTMLElement) || !drawn.parentElement) continue;
        const { fontSize, color } = getComputedStyle(drawn);
        // An inherited color (the body's, a quote's) is left to the target, as a copied paragraph's is.
        const ownColor = color !== getComputedStyle(drawn.parentElement).color;
        const size = readCssFontSize(fontSize);
        for (const p of dom.querySelectorAll<HTMLElement>(`p[data-type="${type}"]`)) {
            if (size !== undefined) p.style.fontSize = `${size}pt`;
            if (ownColor) p.style.color = color;
        }
    }
    event.preventDefault();
    if (items.length > 0) writeEigenClipboard(event, { version: 1, items }, text, dom.innerHTML);
    else {
        event.clipboardData.clearData();
        event.clipboardData.setData('text/html', dom.innerHTML);
        if (text) event.clipboardData.setData('text/plain', text);
    }
    if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
    return true;
}

// A text item lands as a paragraph per line at the caret, with the typography docs models; it has no
// fontSize, letter-spacing or line-height.
function eigenTextItemContent({ text, typography: typo }: EigenClipboardTextItem): JSONContent[] {
    if (!text.trim()) return [];
    const textStyleAttrs: Record<string, string> = {};
    if (typo?.fontFamily) textStyleAttrs.fontFamily = getFontName(typo.fontFamily);
    if (typo?.color) textStyleAttrs.color = typo.color;
    const marks: { type: string; attrs?: Record<string, string> }[] = [];
    if (Object.keys(textStyleAttrs).length > 0) marks.push({ type: 'textStyle', attrs: textStyleAttrs });
    if (typo?.fontWeight === 'bold') marks.push({ type: 'bold' });
    if (typo?.fontStyle === 'italic') marks.push({ type: 'italic' });
    if (typo?.textDecoration === 'underline') marks.push({ type: 'underline' });
    if (typo?.textDecoration === 'line-through') marks.push({ type: 'strike' });
    // An unrecognized wire alignment reads as left, the alignment an unaligned paragraph has, rather than storing garbage.
    const textAlign = oneOf(typo?.textAlign, TEXT_ALIGNS, 'left');
    return text.split('\n').map((line) => ({
        type: 'paragraph',
        ...(textAlign !== 'left' ? { attrs: { textAlign } } : {}),
        // A text node may not be empty, so an empty line is a paragraph with no content.
        ...(line ? { content: [{ type: 'text', text: line, ...(marks.length > 0 ? { marks } : {}) }] } : {}),
    }));
}

// The eigen items at the caret. Each image's stored name comes first, from `pastedMediaName` (null skips the image),
// once per media name and all at once, so a figure pasted twice re-uploads once. A docs copy, whose HTML ProseMirror
// marked with data-pm-slice, pastes through that HTML, which keeps the headings, lists and marks its text items
// flatten; a figure with no item (unresolved at copy) or a failed re-upload is dropped, so none pastes broken. Any
// other payload is placed in wire order, text as whole paragraphs, so beside text an image takes a paragraph of its
// own; an image-only paste stays inline at the caret. A chart is as wide as it came, or `columnWidth` keeping its
// shape when wider, as a pasted span.chart is.
export async function insertEigenItems(
    editor: Editor,
    items: EigenClipboardItem[],
    html: string,
    pastedMediaName: (item: EigenClipboardImageItem) => Promise<string | null>,
    columnWidth: number,
): Promise<void> {
    const sources = new Map<string, EigenClipboardImageItem>();
    for (const item of items) if (item.type === 'image') sources.set(item.mediaName, item);
    const storedNames = new Map(
        await Promise.all([...sources].map(async ([name, item]) => [name, await pastedMediaName(item)] as const)),
    );
    if (editor.isDestroyed) return;

    const docsCopy = new DOMParser().parseFromString(html, 'text/html');
    if (docsCopy.querySelector('[data-pm-slice]')) {
        for (const img of docsCopy.querySelectorAll('img[data-media-name]')) {
            const mediaName = storedNames.get(img.getAttribute('data-media-name') ?? '');
            if (mediaName) img.setAttribute('data-media-name', mediaName);
            else (img.closest('.figure') ?? img).remove();
        }
        editor.view.pasteHTML(docsCopy.body.innerHTML);
        return;
    }

    const withText = items.some((item) => item.type === 'text' && clipboardTextItemHasContent(item));
    for (const item of items) {
        if (item.type === 'text') {
            const paragraphs = eigenTextItemContent(item);
            if (paragraphs.length > 0) editor.chain().focus().insertContent(paragraphs).run();
            continue;
        }
        const node = atomContent(item, storedNames, columnWidth);
        if (!node) continue;
        editor
            .chain()
            .focus()
            .insertContent(withText ? { type: 'paragraph', content: [node] } : node)
            .run();
    }
}

// An image item as a figure under its stored name, a chart item as a chart in its look.
function atomContent(
    item: EigenClipboardItem,
    storedNames: Map<string, string | null>,
    columnWidth: number,
): JSONContent | null {
    if (item.type === 'image') {
        const mediaName = storedNames.get(item.mediaName);
        if (!mediaName) return null;
        const { width } = readClipboardBox(item);
        return { type: 'figure', attrs: { mediaName, width, caption: item.caption } };
    }
    if (item.type !== 'chart') return null;
    const scale = Math.min(1, columnWidth / item.width);
    const { spec, look } = item;
    return { type: 'chart', attrs: { spec, width: item.width * scale, height: item.height * scale, ...look } };
}
