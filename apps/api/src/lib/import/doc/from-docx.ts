import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { getDocExtensions, PAGE_BREAK_CLASS } from '@workspace/lib/docs/eigendoc';
import DOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { assertDecompressedSizeWithinBounds } from '../zip-size-guard';

export type DocxImage = {
    name: string;
    data: Buffer;
    contentType: string;
};

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
};

type MammothElement = {
    type: string;
    value?: string;
    breakType?: string;
    numbering?: { level: string } | null;
    children?: MammothElement[];
};

type MammothDocument = MammothElement & {
    notes: { resolve(reference: MammothElement): MammothElement & { body: MammothElement[] } };
};

// Bare, outside any paragraph: mammoth writes it as the style-mapped hr, between two lists or headings
// rather than inside one.
const PAGE_BREAK: MammothElement = { type: 'break', breakType: 'page' };

// Not a non-breaking space: that's a spacer.
const ASCII_WHITESPACE = /[ \t\r\n]/g;

const extensions = getDocExtensions();
const schema = getSchema(extensions);
const parser = PmDOMParser.fromSchema(schema);

export { schema as docSchema };

export async function docxToPmJson(buffer: Buffer): Promise<{ json: JSONContent; images: DocxImage[] }> {
    // loadAsync reads the central directory without decompressing, so the size guard runs
    // BEFORE mammoth inflates the package — the OOM a bomb triggers inside the parser is not
    // catchable. A non-zip buffer fails here and surfaces as the caller's 400.
    await assertDecompressedSizeWithinBounds(await JSZip.loadAsync(buffer), 'Document too large');

    const mammoth = (await import('mammoth')).default;
    const images: DocxImage[] = [];
    let imageIndex = 0;

    const result = await mammoth.convertToHtml(
        { buffer },
        {
            // Fresh, so two breaks in a row stay two hrs rather than collapse into one.
            styleMap: [`br[type='page'] => hr.${PAGE_BREAK_CLASS}:fresh`],
            transformDocument: splitDocument,
            convertImage: mammoth.images.imgElement(async (image) => {
                const data = await image.readAsBuffer();
                const name = `image-${imageIndex++}.${IMAGE_EXTENSION_BY_MIME[image.contentType] ?? 'png'}`;
                images.push({ name, data, contentType: image.contentType });
                // FigureNode resolves the image by data-media-name; mammoth passes extra attributes through.
                return { src: '', 'data-media-name': name };
            }),
        },
    );

    const sanitized = DOMPurify.sanitize(result.value, {
        ADD_ATTR: ['data-media-name'],
        FORCE_BODY: true,
    });

    const dom = new JSDOM(`<!DOCTYPE html><html><body>${sanitized}</body></html>`);
    // A half holding only a bookmark or a checkbox, which the schema doesn't keep, is left an empty block.
    for (const hr of dom.window.document.querySelectorAll(`hr.${PAGE_BREAK_CLASS}`)) {
        if (isEmptyBlock(hr.previousElementSibling)) hr.previousElementSibling.remove();
        if (isEmptyBlock(hr.nextElementSibling)) hr.nextElementSibling.remove();
    }
    const pmDoc = parser.parse(dom.window.document.body);

    return { json: pmDoc.toJSON(), images };
}

// A note isn't paged, so a break in one goes. mammoth reads a note's body through notes.resolve, out of
// the split's reach, so the notes get a resolve that strips the breaks.
function splitDocument(document: MammothDocument): MammothDocument {
    const { notes } = document;
    return {
        ...splitAtPageBreaks(document),
        notes: {
            resolve: (reference) => {
                const note = notes.resolve(reference);
                return { ...note, body: note.body.map(withoutPageBreaks) };
            },
        },
    };
}

// A Word page break sits in a paragraph's runs, the eigendoc one is a block. So a paragraph splits at each
// break: the halves keep its style and numbering, and an empty half vanishes with mammoth's other empty paragraphs.
function splitAtPageBreaks(element: MammothElement): MammothElement {
    const { children } = element;
    if (!children) return element;
    return {
        ...element,
        children: children.flatMap((child, index) => {
            if (child.type !== 'paragraph') return [splitAtPageBreaks(child)];
            // A top-level break can't stand inside a nested list without cutting it apart, so there the break goes.
            if (isNestedItem(child)) return [withoutPageBreaks(child)];
            const [first, ...rest] = splitElement(child);
            // Nor between an item and its nested items: the breaks that trail the item's text go, not what they split off.
            if (child.numbering && isNestedItem(children[index + 1])) {
                const trailing = rest.splice(rest.findLastIndex(hasContent) + 1);
                (rest.at(-1) ?? first).children?.push(...trailing.flatMap((part) => part.children ?? []));
            }
            return [first, ...rest.flatMap((part) => [PAGE_BREAK, part])];
        }),
    };
}

// A run or hyperlink holding a break splits in two along with its paragraph.
function splitElement(element: MammothElement): [MammothElement, ...MammothElement[]] {
    if (!element.children) return [element];
    let children: MammothElement[] = [];
    const parts: [MammothElement, ...MammothElement[]] = [{ ...element, children }];
    for (const child of element.children) {
        if (isPageBreak(child)) {
            children = [];
            parts.push({ ...element, children });
            continue;
        }
        const [first, ...rest] = splitElement(child);
        children.push(first);
        for (const part of rest) {
            children = [part];
            parts.push({ ...element, children });
        }
    }
    return parts;
}

function isEmptyBlock(element: Element | null): element is Element {
    return (
        !!element?.matches('p, h1, h2, h3, h4, h5, h6') &&
        !element.textContent?.replace(ASCII_WHITESPACE, '') &&
        !element.querySelector('img, br')
    );
}

function hasContent(element: MammothElement): boolean {
    return (
        element.type === 'image' ||
        (element.type === 'text' && !!element.value?.replace(ASCII_WHITESPACE, '')) ||
        !!element.children?.some(hasContent)
    );
}

function withoutPageBreaks(element: MammothElement): MammothElement {
    if (!element.children) return element;
    return { ...element, children: element.children.filter((child) => !isPageBreak(child)).map(withoutPageBreaks) };
}

function isPageBreak(element: MammothElement): boolean {
    return element.type === 'break' && element.breakType === 'page';
}

function isNestedItem(element: MammothElement | undefined): boolean {
    return !!element?.numbering && element.numbering.level !== '0';
}
