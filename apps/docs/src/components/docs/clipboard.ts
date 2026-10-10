import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { ClipboardBox } from '@workspace/lib/clipboard';
import {
    buildImageClipboardItem,
    buildTextClipboardItem,
    clipboardTextItemHasContent,
    readClipboardBox,
    writeEigenClipboard,
} from '@workspace/lib/clipboard';
import { getFontName } from '@workspace/lib/constants/fonts';
import { htmlToPlainText } from '@workspace/lib/html-dom';
import type {
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_IMAGE_BOX } from '@workspace/lib/vector';

// Block-level text-align values docs models; an unrecognized wire value drops rather than storing garbage.
const TEXT_ALIGNS = new Set(['left', 'center', 'right', 'justify']);

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
// resolves, and the text between them as a text item, a line per paragraph. None resolves → no items,
// and the copy is ProseMirror's own.
function copiedClipboardItems(
    view: EditorView,
    from: number,
    to: number,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem[] {
    const items: EigenClipboardItem[] = [];
    let runFrom = from;
    const pushText = (runTo: number) => {
        const text = view.state.doc.textBetween(runFrom, runTo, '\n').trim();
        if (text) items.push(buildTextClipboardItem({ text, box: textRunBox(view, runFrom, runTo) }));
    };
    view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== 'figure' || !node.attrs.mediaName) return;
        const mediaPath = resolveMediaPath(node.attrs.mediaName);
        if (!mediaPath) return;
        pushText(pos);
        runFrom = pos + node.nodeSize;
        items.push(
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
// cut deletes the selection before any later listener reads it. No items → false, and the event is ProseMirror's.
export function writeDocsClipboard(
    view: EditorView,
    event: ClipboardEvent,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): boolean {
    const { selection } = view.state;
    const cut = event.type === 'cut';
    if (selection.empty || !event.clipboardData || (cut && !view.editable)) return false;
    const items = copiedClipboardItems(view, selection.from, selection.to, resolveMediaPath);
    if (items.length === 0) return false;
    const { dom, text } = view.serializeForClipboard(selection.content());
    event.preventDefault();
    writeEigenClipboard(event, { version: 1, items }, text || undefined, dom.innerHTML);
    if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
    return true;
}

// A text item lands as a paragraph per line at the caret, with the typography docs models; it has no
// fontSize, letter-spacing or line-height. htmlToPlainText guards against a non-conforming payload.
function eigenTextItemContent(item: EigenClipboardTextItem): JSONContent[] {
    const text = htmlToPlainText(item.text);
    if (!text.trim()) return [];
    const typo = item.typography;
    const textStyleAttrs: Record<string, string> = {};
    if (typo?.fontFamily) textStyleAttrs.fontFamily = getFontName(typo.fontFamily);
    if (typo?.color) textStyleAttrs.color = typo.color;
    const marks: { type: string; attrs?: Record<string, string> }[] = [];
    if (Object.keys(textStyleAttrs).length > 0) marks.push({ type: 'textStyle', attrs: textStyleAttrs });
    if (typo?.fontWeight === 'bold') marks.push({ type: 'bold' });
    if (typo?.fontStyle === 'italic') marks.push({ type: 'italic' });
    if (typo?.textDecoration === 'underline') marks.push({ type: 'underline' });
    if (typo?.textDecoration === 'line-through') marks.push({ type: 'strike' });
    return text.split('\n').map((line) => ({
        type: 'paragraph',
        ...(typo?.textAlign && TEXT_ALIGNS.has(typo.textAlign) ? { attrs: { textAlign: typo.textAlign } } : {}),
        // A text node may not be empty, so an empty line is a paragraph with no content.
        ...(line ? { content: [{ type: 'text', text: line, ...(marks.length > 0 ? { marks } : {}) }] } : {}),
    }));
}

// The eigen items at the caret. Each image's stored name comes first, from `pastedMediaName` (null skips the image),
// once per media name and all at once, so a figure pasted twice re-uploads once. A docs copy, whose HTML ProseMirror
// marked with data-pm-slice, pastes through that HTML, which keeps the headings, lists and marks its text items
// flatten; a figure with no item (unresolved at copy) or a failed re-upload is dropped, so none pastes broken. Any
// other payload is placed in wire order, text as whole paragraphs, so beside text an image takes a paragraph of its
// own; an image-only paste stays inline at the caret.
export async function insertEigenItems(
    editor: Editor,
    items: EigenClipboardItem[],
    html: string,
    pastedMediaName: (item: EigenClipboardImageItem) => Promise<string | null>,
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
        } else if (item.type === 'image') {
            const mediaName = storedNames.get(item.mediaName);
            if (!mediaName) continue;
            const { width } = readClipboardBox(item);
            const figure = { type: 'figure', attrs: { mediaName, width, caption: item.caption } };
            editor
                .chain()
                .focus()
                .insertContent(withText ? { type: 'paragraph', content: [figure] } : figure)
                .run();
        }
    }
}
