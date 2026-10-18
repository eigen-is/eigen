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
import { importError, readPptx } from './from-pptx';
import { PPTX_STYLE } from './shapes';

// Runs in the transform process: the reader and the Yjs encoding both stay off the event loop. The main thread
// appends the update through document/slides.ts, which reads it back through the canvas reader, and writes the media.
export function importPptxToSlidesUpdate(
    data: ArrayBuffer,
    job: Pick<SlidesImportJob, 'frame' | 'maxMediaBytes'>,
): SlidesImportWorkerResult & { warnings: TransformWarning[] } {
    const { slides, media, warnings, slideSize } = readPptx(Buffer.from(data), job);
    let update: Uint8Array;
    try {
        const doc = new Y.Doc();
        doc.transact(() => {
            // A Convert's deck takes it; Import slides… leaves the open deck's meta alone.
            doc.getMap('meta').set('slideSize', slideSize);
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
        throw importError(error);
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
