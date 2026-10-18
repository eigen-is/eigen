import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { type PageSetup, PROSE_TEXTBLOCKS } from '@workspace/lib/docs/eigendoc';
import { ApiError, isOutOfMemory } from '../../core/errors';
import { docSchema } from '../../document/doc-schema';
import type { TransformWarning } from '../../document/transform/protocol';
import { IMPORT_MESSAGES, importError } from '../messages';
import { UNSHOWN_IMAGE_TYPES } from './drawings';
import { CHARS_PER_UNIT, MAX_DOCX_WEIGHT, readPackage } from './package';
import { createReader, readDocument } from './paragraphs';

// docx bytes → eigendoc JSON, straight from the WordprocessingML with no HTML between. Runs in the transform process.

export type DocxImage = {
    name: string;
    data: Buffer;
    contentType: string;
};

// The update holds every character, a string attribute's too (a link's href is spelled out for every text node it
// marks), and a client opens it in one WebSocket message of at most 128 MB: three bytes a character at most. The
// corpus's most is 511,898.
export const MAX_DOCX_TEXT = 16_000_000;

// A TableMap slot, a column of a row however spanned or padded, costs about 16 bytes, a unit 1.3 KB and more.
const SLOTS_PER_UNIT = 64;

// The doc as JSON, for the audit and the tests; the import encodes the doc itself, with no copy between.
export function docxToPmJson(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): { json: JSONContent; page: PageSetup; images: DocxImage[]; warnings: TransformWarning[] } {
    const { doc, page, images, warnings } = readDocx(buffer, options);
    return { json: doc.toJSON(), page, images, warnings };
}

export function readDocx(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): { doc: Node; page: PageSetup; images: DocxImage[]; warnings: TransformWarning[] } {
    try {
        const pkg = readPackage(buffer);
        const reader = createReader(pkg, options.publicOrigin);
        const content = readDocument(reader);
        const { weight, text } = sizeOf(content);
        if (weight > MAX_DOCX_WEIGHT || text > MAX_DOCX_TEXT) throw new ApiError(413, IMPORT_MESSAGES.docx.tooLarge);
        const refused = new Set(content.filter((block) => !fits(block)));
        const blocks = content.flatMap((block) => (refused.has(block) ? asParagraphs(block) : [block]));
        const doc = docSchema().nodeFromJSON({
            type: 'doc',
            content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
        });
        doc.check();
        // Only the media a kept figure names: a flattened block's figures went with it.
        const named = new Set<string>();
        doc.descendants((node) => {
            if (node.type.name === 'figure') named.add(node.attrs['mediaName']);
        });
        const kept = reader.images.filter((image) => named.has(image.name));
        const images = kept.flatMap(({ name, path, contentType }): DocxImage[] => {
            const data = pkg.readMedia(path);
            // A view of the bytes read, not a copy of them: a file may hold 200 MB of media.
            return data
                ? [{ name, contentType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }]
                : [];
        });
        const warnings: TransformWarning[] = [];
        if (refused.size > 0) warnings.push({ code: 'blocks-flattened', count: refused.size });
        const damaged = kept.length - images.length;
        const unshown = damaged + images.filter((image) => UNSHOWN_IMAGE_TYPES.has(image.contentType)).length;
        if (unshown > 0) warnings.push({ code: 'images-unshown', count: unshown });
        if (reader.graphicsDropped > 0) warnings.push({ code: 'graphics-dropped', count: reader.graphicsDropped });
        if (reader.pagesDropped > 0) warnings.push({ code: 'section-pages-dropped', count: reader.pagesDropped });
        return { doc, page: reader.page, images, warnings };
    } catch (error) {
        throw importError(error, 'docx');
    }
}

// The weight is every node and mark, and every table's area; the text every character, string attributes' included.
function sizeOf(nodes: JSONContent[]): { weight: number; text: number } {
    let weight = 0;
    let slots = 0;
    let text = 0;
    const strings = (attrs: Record<string, unknown> | undefined) => {
        for (const value of Object.values(attrs ?? {}))
            if (typeof value === 'string') {
                weight += Math.floor(value.length / CHARS_PER_UNIT);
                text += value.length;
            }
    };
    const stack = [...nodes];
    for (let node = stack.pop(); node; node = stack.pop()) {
        weight += 1 + (node.marks?.length ?? 0);
        text += node.text?.length ?? 0;
        slots += (node.attrs?.['colspan'] ?? 0) * (node.attrs?.['rowspan'] ?? 1);
        strings(node.attrs);
        for (const mark of node.marks ?? []) strings(mark.attrs);
        for (const child of node.content ?? []) stack.push(child);
    }
    return { weight: weight + Math.floor(slots / SLOTS_PER_UNIT), text };
}

function fits(block: JSONContent): boolean {
    try {
        docSchema().nodeFromJSON(block).check();
        return true;
    } catch (error) {
        if (isOutOfMemory(error)) throw error;
        return false;
    }
}

// A block the schema refuses keeps its text and equations as paragraphs, so a reader slip never fails the import.
function asParagraphs(block: JSONContent): JSONContent[] {
    const lines: JSONContent[] = [];
    const walk = (node: JSONContent, line: JSONContent[]) => {
        if (node.type === 'text' && node.text) line.push({ type: 'text', text: node.text });
        else if (node.type === 'equation') line.push(node);
        else if (PROSE_TEXTBLOCKS.includes(node.type ?? '') || node.type === 'codeBlock') {
            const own: JSONContent[] = [];
            for (const child of node.content ?? []) walk(child, own);
            lines.push({ type: 'paragraph', content: own });
        } else for (const child of node.content ?? []) walk(child, line);
    };
    walk(block, []);
    return lines.filter((line) => (line.content ?? []).length > 0);
}
