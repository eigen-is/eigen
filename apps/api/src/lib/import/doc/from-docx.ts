import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import DOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';

export type DocxImage = {
    name: string;
    data: Buffer;
    contentType: string;
};

const extensions = getDocExtensions();
const schema = getSchema(extensions);
const parser = PmDOMParser.fromSchema(schema);

export { schema as docSchema };

export async function docxToPmJson(buffer: Buffer): Promise<{ pmJson: JSONContent; images: DocxImage[] }> {
    const mammoth = (await import('mammoth')).default;
    const images: DocxImage[] = [];
    let imageIndex = 0;

    const result = await mammoth.convertToHtml(
        { buffer },
        {
            convertImage: mammoth.images.imgElement(async (image) => {
                const data = await image.readAsBuffer();
                const ext = extensionFromMime(image.contentType);
                const name = `image-${imageIndex++}.${ext}`;
                images.push({ name, data, contentType: image.contentType });
                // mammoth types only model { src }, but we need data-media-name for FigureNode
                return { src: '', 'data-media-name': name } as { src: string };
            }),
        },
    );

    const sanitized = DOMPurify.sanitize(result.value, {
        ADD_ATTR: ['data-media-name'],
        FORCE_BODY: true,
    });

    const dom = new JSDOM(`<!DOCTYPE html><html><body>${sanitized}</body></html>`);
    const pmDoc = parser.parse(dom.window.document.body);

    // ProseMirror's toJSON() returns the correct JSONContent shape
    return { pmJson: pmDoc.toJSON() as JSONContent, images };
}

function extensionFromMime(contentType: string): string {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/tiff': 'tiff',
        'image/bmp': 'bmp',
    };
    return map[contentType] ?? 'png';
}
