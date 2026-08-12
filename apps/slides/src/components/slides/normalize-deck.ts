import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import type * as Y from 'yjs';

export function normalizeDeck(yjsDoc: Y.Doc) {
    const slidesMap = yjsDoc.getMap('slides');
    const objectsMap = yjsDoc.getMap('objects');
    const slideIds = Array.from(slidesMap.keys());
    const objectIds = Array.from(objectsMap.keys());

    const objectToSlides: Record<string, string[]> = {};

    for (const slideId of slideIds) {
        const slideValue = slidesMap.get(slideId);
        if (!slideValue) continue;
        const slide = slideValue as Y.Map<unknown>;
        const objIdsArray = slide.get('objectIds') as Y.Array<string>;
        if (!objIdsArray) continue;
        for (const objId of objIdsArray.toArray() as string[]) {
            if (!objectToSlides[objId]) objectToSlides[objId] = [];
            objectToSlides[objId].push(slideId);
        }
    }

    for (const [objId, slides] of Object.entries(objectToSlides)) {
        if (slides.length <= 1) continue;
        for (let i = 0; i < slides.length - 1; i++) {
            const sId = slides[i];
            const slideValue = slidesMap.get(sId);
            if (!slideValue) continue;
            const slide = slideValue as Y.Map<unknown>;
            const objIdsArray = slide.get('objectIds') as Y.Array<string>;
            const idx = (objIdsArray.toArray() as string[]).indexOf(objId);
            if (idx !== -1) objIdsArray.delete(idx, 1);
        }
    }

    for (const objId of objectIds) {
        const objValue = objectsMap.get(objId);
        if (!objValue) continue;
        const obj = objValue as Y.Map<unknown>;
        if (obj.get('type') === 'text' && !obj.get('fontFamily')) {
            obj.set('fontFamily', EIGEN_FONTS[0].name);
        }
    }

    if (slideIds.length > 0) {
        const firstSlideValue = slidesMap.get(slideIds[0]);
        if (firstSlideValue) {
            const firstSlide = firstSlideValue as Y.Map<unknown>;
            const firstObjIds = firstSlide.get('objectIds') as Y.Array<string>;
            for (const objId of objectIds) {
                if (!objectToSlides[objId] || objectToSlides[objId].length === 0) {
                    firstObjIds.push([objId]);
                }
            }
        }
    }
}
