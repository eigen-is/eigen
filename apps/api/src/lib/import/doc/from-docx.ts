import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { BandRoot, NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import { BAND_EXCLUDED_NODES, BAND_ROOTS, bandHasContent, PROSE_TEXTBLOCKS } from '@workspace/lib/docs/eigendoc';
import { ApiError, isOutOfMemory } from '../../core/errors';
import { docSchema } from '../../document/doc-schema';
import { readStoredEquation } from '../../document/equation';
import type { TransformWarning } from '../../document/transform/protocol';
import { lossCounter } from '../../document/transform/protocol';
import { IMPORT_MESSAGES, importError } from '../messages';
import { UNSHOWN_IMAGE_TYPES } from './drawings';
import { CHARS_PER_UNIT, MAX_DOCX_WEIGHT, readPackage } from './package';
import { createReader, readBand, readDocument } from './paragraphs';

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
): {
    json: JSONContent;
    bands: Partial<Record<BandRoot, JSONContent>>;
    page: PageSetup;
    style: NormalStyle;
    images: DocxImage[];
    warnings: TransformWarning[];
} {
    const { doc, bands, page, style, images, warnings } = readDocx(buffer, options);
    const json = Object.fromEntries(Object.entries(bands).map(([root, band]) => [root, band.toJSON()]));
    return { json: doc.toJSON(), bands: json, page, style, images, warnings };
}

export function readDocx(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): {
    doc: Node;
    bands: Partial<Record<BandRoot, Node>>;
    page: PageSetup;
    style: NormalStyle;
    images: DocxImage[];
    warnings: TransformWarning[];
} {
    try {
        const losses = lossCounter();
        const pkg = readPackage(buffer, losses.lost);
        const reader = createReader(pkg, losses.lost, options.publicOrigin);
        const content = readDocument(reader);
        // A band's schema holds none of BAND_EXCLUDED_NODES: each keeps its text.
        const withoutExcluded = (node: JSONContent): JSONContent[] => {
            if (!BAND_EXCLUDED_NODES.has(node.type ?? '')) {
                return [node.content ? { ...node, content: node.content.flatMap(withoutExcluded) } : node];
            }
            losses.lost('blocks-flattened');
            return asParagraphs(node);
        };
        // A part several references name is read once, and each copy weighed.
        const read = new Map<string, JSONContent[]>();
        const bandContent = BAND_ROOTS.flatMap((root): [BandRoot, JSONContent[]][] => {
            const part = pkg.bands[root];
            if (!part) return [];
            const blocks = read.get(part.path) ?? readBand(reader, part).flatMap(withoutExcluded);
            read.set(part.path, blocks);
            return [[root, blocks]];
        });
        const { weight, text } = sizeOf([...content, ...bandContent.flatMap(([, blocks]) => blocks)]);
        if (weight > MAX_DOCX_WEIGHT || text > MAX_DOCX_TEXT) throw new ApiError(413, IMPORT_MESSAGES.docx.tooLarge);
        // A block the schema refuses keeps its text and equations as paragraphs, so a reader slip never fails the import.
        const checked = (blocks: JSONContent[]) => {
            const kept = blocks.flatMap((block) => {
                if (fits(block)) return [block];
                losses.lost('blocks-flattened');
                return asParagraphs(block);
            });
            const node = docSchema().nodeFromJSON({
                type: 'doc',
                content: kept.length > 0 ? kept : [{ type: 'paragraph' }],
            });
            node.check();
            return node;
        };
        const doc = checked(content);
        const bands: Partial<Record<BandRoot, Node>> = {};
        for (const [root, blocks] of bandContent) {
            const band = checked(blocks);
            if (bandHasContent(band, readStoredEquation)) bands[root] = band;
        }
        // Only the media a kept figure names: a flattened block's figures went with it.
        const named = new Set<string>();
        for (const node of [doc, ...Object.values(bands)])
            node.descendants((child) => {
                if (child.type.name === 'figure') named.add(child.attrs['mediaName']);
            });
        const kept = reader.images.filter((image) => named.has(image.name));
        const images = kept.flatMap(({ name, path, contentType }): DocxImage[] => {
            const data = pkg.readMedia(path);
            // A part that doesn't read, or one no browser draws, is a figure showing its alt text in a broken image.
            if (!data || UNSHOWN_IMAGE_TYPES.has(contentType)) losses.lost('images-unshown');
            // A view of the bytes read, not a copy of them: a file may hold 200 MB of media.
            return data
                ? [{ name, contentType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }]
                : [];
        });
        return { doc, bands, page: reader.page, style: reader.normal, images, warnings: losses.warnings() };
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
