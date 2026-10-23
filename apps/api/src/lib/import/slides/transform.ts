import {
    generateNKeysBetween,
    newFrameId,
    serializeBackgroundFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import {
    type SlidesImportJob,
    type SlidesImportWorkerResult,
    type TransformWarning,
    toTransferableBuffer,
} from '../../document/transform/protocol';
import { importError } from '../messages';
import { readPptx } from './from-pptx';
import { PPTX_STYLE } from './shapes';

// Runs in the transform process: the reader and the Yjs encoding both stay off the event loop. The main thread
// appends the update through document/slides.ts, which reads it back through the canvas reader, and writes the media.
export function importPptxToSlidesUpdate(
    data: ArrayBuffer,
    job: Pick<SlidesImportJob, 'deck' | 'maxMediaBytes'>,
): SlidesImportWorkerResult & { warnings: TransformWarning[] } {
    const { slides, media, warnings, page } = readPptx(Buffer.from(data), job);
    let update: Uint8Array;
    try {
        const doc = new Y.Doc();
        doc.transact(() => {
            // A Convert's new deck takes the page; on Import slides… it is the open deck's own, and the append leaves
            // that deck's meta alone (document/slides.ts).
            const meta = doc.getMap('meta');
            meta.set('slideSize', page.slideSize);
            meta.set('slideWidth', page.slideWidth);
            const frameKeys = generateNKeysBetween(null, null, slides.length);
            const elementKeys = generateNKeysBetween(
                null,
                null,
                slides.reduce((sum, slide) => sum + slide.elements.length, 0),
            );
            let next = 0;
            for (const [i, slide] of slides.entries()) {
                const frameId = newFrameId();
                writeFrameInDoc(doc, {
                    id: frameId,
                    index: frameKeys[i],
                    name: slide.name,
                    ...(slide.background && { background: serializeBackgroundFill(slide.background) }),
                });
                for (const element of slide.elements)
                    writeElementInDoc(doc, { ...element, frameId }, elementKeys[next++], PPTX_STYLE);
            }
        });
        update = Y.encodeStateAsUpdate(doc);
        doc.destroy();
    } catch (error) {
        throw importError(error, 'pptx');
    }
    return {
        update: toTransferableBuffer(update),
        images: media.map((image) => ({
            name: image.name,
            contentType: image.contentType,
            data: toTransferableBuffer(image.data),
        })),
        warnings,
    };
}
