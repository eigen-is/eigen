import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../core/errors';
import { XmlError } from '../../core/xml';
import { ZipError } from '../../core/zip';
import type { TransformWarning } from '../../document/transform/protocol';
import { lowlight } from '../../export/doc/render';
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

export async function docxToPmJson(
    buffer: Buffer,
    options: { publicOrigin?: string } = {},
): Promise<{ json: JSONContent; images: DocxImage[]; warnings: TransformWarning[] }> {
    try {
        const pkg = readPackage(buffer);
        const reader = createReader(pkg, options.publicOrigin);
        const content = readDocument(reader);
        const refused = new Set(content.filter((block) => !fits(block)));
        const blocks = content.flatMap((block) => (refused.has(block) ? asParagraphs(block) : [block]));
        const doc = docSchema.nodeFromJSON({
            type: 'doc',
            content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
        });
        doc.check();
        const images = reader.images.map(({ name, path, contentType }) => ({
            name,
            contentType,
            data: Buffer.from(pkg.zip.read(path) ?? new Uint8Array()),
        }));
        const warnings: TransformWarning[] = [];
        if (refused.size > 0) warnings.push({ code: 'blocks-flattened', count: refused.size });
        const unshown = images.filter((image) => UNSHOWN_IMAGE_TYPES.has(image.contentType)).length;
        if (unshown > 0) warnings.push({ code: 'images-unshown', count: unshown });
        return { json: doc.toJSON(), images, warnings };
    } catch (error) {
        // The zip's and the XML's messages speak of archives and markup; the user uploaded a document.
        if (error instanceof ZipError)
            throw new ApiError(error.status, error.status === 413 ? DOCUMENT_TOO_LARGE : NOT_A_DOCX, { cause: error });
        if (error instanceof XmlError) throw new ApiError(400, NOT_A_DOCX, { cause: error });
        throw error;
    }
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
