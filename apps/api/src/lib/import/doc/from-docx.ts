import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../core/errors';
import { XmlError } from '../../core/xml';
import { ZipError } from '../../core/zip';
import { lowlight } from '../../document/lowlight';
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

export const docSchema = getSchema(getDocExtensions({ lowlight }));

// Each node and mark the reader emits is a Yjs item: 1.3 to 2.4 KB of peak memory through the transform per unit of
// weight, 3.8 KB for a cell's 63 column widths. At this budget the heaviest file met peaks near 1 GB, and the corpus's
// heaviest weighs 57,688.
export const MAX_DOCX_WEIGHT = 150_000;

// A string attribute is spelled out in the update for every node or mark that carries it: about 3.5 bytes a character.
const CHARS_PER_UNIT = 512;

export function docxToPmJson(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): { json: JSONContent; images: DocxImage[]; warnings: TransformWarning[] } {
    try {
        const pkg = readPackage(buffer);
        const reader = createReader(pkg, options.publicOrigin);
        const content = readDocument(reader);
        if (weightOf(content) > MAX_DOCX_WEIGHT) throw new ApiError(413, DOCUMENT_TOO_LARGE);
        const refused = new Set(content.filter((block) => !fits(block)));
        const blocks = content.flatMap((block) => (refused.has(block) ? asParagraphs(block) : [block]));
        const doc = docSchema.nodeFromJSON({
            type: 'doc',
            content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
        });
        doc.check();
        const images = reader.images.map(({ name, path, contentType }) => {
            // A view of the bytes read, not a copy of them: a file may hold 200 MB of media.
            const data = pkg.zip.read(path) ?? new Uint8Array();
            return { name, contentType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
        });
        const warnings: TransformWarning[] = [];
        if (refused.size > 0) warnings.push({ code: 'blocks-flattened', count: refused.size });
        const unshown = images.filter((image) => UNSHOWN_IMAGE_TYPES.has(image.contentType)).length;
        if (unshown > 0) warnings.push({ code: 'images-unshown', count: unshown });
        if (reader.graphicsDropped > 0) warnings.push({ code: 'graphics-dropped', count: reader.graphicsDropped });
        return { json: doc.toJSON(), images, warnings };
    } catch (error) {
        // The zip's and the XML's messages speak of archives and markup; the user uploaded a document.
        if (error instanceof ZipError)
            throw new ApiError(error.status, error.status === 413 ? DOCUMENT_TOO_LARGE : NOT_A_DOCX, { cause: error });
        // A file the reader slips on is refused as one it can't read, not as a server error.
        if (error instanceof XmlError || !(error instanceof ApiError))
            throw new ApiError(400, NOT_A_DOCX, { cause: error });
        throw error;
    }
}

// Every node and mark, and the cells prosemirror-tables fills a ragged table with on open, each with its paragraph.
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
        if (node.type === 'table') weight += 2 * missingCells(node);
        for (const child of node.content ?? []) stack.push(child);
    }
    return weight;
}

// The table's width as prosemirror-tables reads it, a row's cells and the rowspans reaching into it, by its rows,
// less the slots its cells fill.
function missingCells(table: JSONContent): number {
    const rows = table.content ?? [];
    const reaching = new Array<number>(rows.length + 1).fill(0);
    let width = 0;
    let filled = 0;
    let carried = 0;
    for (const [index, row] of rows.entries()) {
        carried += reaching[index] ?? 0;
        let own = 0;
        for (const cell of row.content ?? []) {
            const colspan = Number(cell.attrs?.['colspan'] ?? 1);
            const rowspan = Math.min(Number(cell.attrs?.['rowspan'] ?? 1), rows.length - index);
            own += colspan;
            filled += colspan * rowspan;
            reaching[index + 1] = (reaching[index + 1] ?? 0) + colspan;
            reaching[index + rowspan] = (reaching[index + rowspan] ?? 0) - colspan;
        }
        width = Math.max(width, own + carried);
    }
    return width * rows.length - filled;
}

function fits(block: JSONContent): boolean {
    try {
        docSchema.nodeFromJSON(block).check();
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
