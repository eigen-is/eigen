import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { ApiError } from '../../core/errors';
import { XmlError } from '../../core/xml';
import { ZipError } from '../../core/zip';
import { docSchema } from '../../document/doc-schema';
import type { TransformWarning } from '../../document/transform/protocol';
import { UNSHOWN_IMAGE_TYPES } from './drawings';
import { DOCUMENT_TOO_LARGE, NOT_A_DOCX, readPackage } from './package';
import { createReader, readDocument } from './paragraphs';

// docx bytes → eigendoc JSON, straight from the WordprocessingML with no HTML between. Runs in the transform Worker.

export type DocxImage = {
    name: string;
    data: Buffer;
    contentType: string;
};

// Each node and mark the reader emits is a Yjs item: 1.3 to 2.4 KB of peak memory through the transform per unit of
// weight, 3.8 KB for a cell's 63 column widths. At this budget the heaviest file met peaks near 1 GB, and the corpus's
// heaviest weighs 57,688.
export const MAX_DOCX_WEIGHT = 150_000;

// A string attribute is spelled out in the update for every node or mark that carries it: about 3.5 bytes a character.
const CHARS_PER_UNIT = 512;

// The doc as JSON, for the audit and the tests; the import encodes the doc itself, with no copy between.
export function docxToPmJson(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): { json: JSONContent; images: DocxImage[]; warnings: TransformWarning[] } {
    const { doc, images, warnings } = readDocx(buffer, options);
    return { json: doc.toJSON(), images, warnings };
}

export function readDocx(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): { doc: Node; images: DocxImage[]; warnings: TransformWarning[] } {
    try {
        const pkg = readPackage(buffer);
        const reader = createReader(pkg, options.publicOrigin);
        const content = readDocument(reader);
        if (weightOf(content) > MAX_DOCX_WEIGHT) throw new ApiError(413, DOCUMENT_TOO_LARGE);
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
        return { doc, images, warnings };
    } catch (error) {
        // The zip's and the XML's messages speak of archives and markup; the user uploaded a document.
        if (error instanceof ZipError)
            throw new ApiError(error.status, error.status === 413 ? DOCUMENT_TOO_LARGE : NOT_A_DOCX, { cause: error });
        if (error instanceof XmlError) throw new ApiError(400, NOT_A_DOCX, { cause: error });
        if (error instanceof ApiError) throw error;
        // A file the reader slips on is refused as one it can't read; the slip is a bug, and its cause stays in the Worker.
        console.warn('[import] docx reader failed:', error instanceof Error ? (error.stack ?? error.message) : error);
        throw new ApiError(400, NOT_A_DOCX, { cause: error });
    }
}

// Every node and mark.
function weightOf(nodes: JSONContent[]): number {
    let weight = 0;
    const strings = (attrs: Record<string, unknown> | undefined) => {
        for (const value of Object.values(attrs ?? {}))
            if (typeof value === 'string') weight += Math.floor(value.length / CHARS_PER_UNIT);
    };
    const stack = [...nodes];
    for (let node = stack.pop(); node; node = stack.pop()) {
        weight += 1 + (node.marks?.length ?? 0);
        strings(node.attrs);
        for (const mark of node.marks ?? []) strings(mark.attrs);
        for (const child of node.content ?? []) stack.push(child);
    }
    return weight;
}

function fits(block: JSONContent): boolean {
    try {
        docSchema().nodeFromJSON(block).check();
        return true;
    } catch {
        return false;
    }
}

// A block the schema refuses keeps its text as paragraphs, so a reader slip never fails the import.
function asParagraphs(block: JSONContent): JSONContent[] {
    const lines: JSONContent[] = [];
    const walk = (node: JSONContent, line: JSONContent[]) => {
        if (node.type === 'text' && node.text) line.push({ type: 'text', text: node.text });
        else if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
            const own: JSONContent[] = [];
            for (const child of node.content ?? []) walk(child, own);
            lines.push({ type: 'paragraph', content: own });
        } else for (const child of node.content ?? []) walk(child, line);
    };
    walk(block, []);
    return lines.filter((line) => (line.content ?? []).length > 0);
}
