// The pptx import's step in the transform process: the reader's slides encoded as one Yjs update of frames and
// elements, so the reader and the encoding both stay off the event loop. The main thread inserts the slides or
// replaces the deck's with them, and writes the pictures through Drive.

import {
    generateNKeysBetween,
    newFrameId,
    serializeBackgroundFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import type { SlidesImportJob, SlidesImportWorkerResult, TransformWarning } from '../../document/transform/protocol';
import { toTransferableBuffer, toTransferableMedia } from '../../document/transform/protocol';
import { importError } from '../messages';
import { readPptx } from './from-pptx';
import { PPTX_STYLE } from './shapes';

export function importPptxToSlidesUpdate(
    data: ArrayBuffer,
    job: Pick<SlidesImportJob, 'deck' | 'maxMediaBytes'>,
): SlidesImportWorkerResult & { warnings: TransformWarning[] } {
    const { slides, media, warnings, page } = readPptx(Buffer.from(data), job);
    let update: Uint8Array;
    try {
        const doc = new Y.Doc();
        doc.transact(() => {
            // A Convert's or a replace's deck takes the page. On an inserting Import… it is the open deck's own, and the
            // insert leaves that deck's meta alone.
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
        images: toTransferableMedia(media),
        warnings,
    };
}
