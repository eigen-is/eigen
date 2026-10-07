import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
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

// mammoth's document tree, as far as the page-break split reads it.
type MammothElement = { type: string; breakType?: string; children?: MammothElement[] };

// Unstyled and unnumbered, so the break stands between two lists or headings rather than inside one.
const PAGE_BREAK_PARAGRAPH: MammothElement = { type: 'paragraph', children: [{ type: 'break', breakType: 'page' }] };

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
            styleMap: ["br[type='page'] => hr.page-break"],
            transformDocument: splitAtPageBreaks,
            convertImage: mammoth.images.imgElement(async (image) => {
                const data = await image.readAsBuffer();
                const ext = extensionFromMime(image.contentType);
                const name = `image-${imageIndex++}.${ext}`;
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
    // A break's own paragraph parses as <p></p><hr><p></p>: an hr closes the paragraph it sits in.
    for (const hr of dom.window.document.querySelectorAll('hr.page-break')) {
        for (const sibling of [hr.previousElementSibling, hr.nextElementSibling]) {
            if (sibling?.tagName === 'P' && !sibling.hasChildNodes()) sibling.remove();
        }
    }
    const pmDoc = parser.parse(dom.window.document.body);

    return { json: pmDoc.toJSON(), images };
}

// A Word page break sits in a paragraph's runs, the eigendoc one is a block. So a paragraph splits at each
// break: the halves keep its style and numbering, the break gets an unstyled paragraph of its own, and an
// empty half vanishes with mammoth's other empty paragraphs.
function splitAtPageBreaks(element: MammothElement): MammothElement {
    if (!element.children) return element;
    return {
        ...element,
        children: element.children.flatMap((child) =>
            child.type === 'paragraph' ? splitParagraph(child) : [splitAtPageBreaks(child)],
        ),
    };
}

function splitParagraph(paragraph: MammothElement): MammothElement[] {
    const [first = [], ...rest] = splitChildren(paragraph.children ?? []);
    return [
        { ...paragraph, children: first },
        ...rest.flatMap((children) => [PAGE_BREAK_PARAGRAPH, { ...paragraph, children }]),
    ];
}

// The children before, between and after the page breaks; a run or hyperlink holding one splits in two.
function splitChildren(children: MammothElement[]): MammothElement[][] {
    let current: MammothElement[] = [];
    const segments = [current];
    for (const child of children) {
        if (child.type === 'break' && child.breakType === 'page') {
            current = [];
            segments.push(current);
        } else if (child.children) {
            const [first = [], ...rest] = splitChildren(child.children);
            current.push({ ...child, children: first });
            for (const part of rest) {
                current = [{ ...child, children: part }];
                segments.push(current);
            }
        } else {
            current.push(child);
        }
    }
    return segments;
}

function extensionFromMime(contentType: string): string {
    return IMAGE_EXTENSION_BY_MIME[contentType] ?? 'png';
}
