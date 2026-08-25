import { describe, expect, it } from 'bun:test';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import * as Y from 'yjs';
import { normalizeDeck } from '../../../components/slides/normalize-deck';

// Build a slides doc the way use-deck does: a `slides` map of Y.Maps (each with an `objectIds`
// Y.Array), an `objects` map of Y.Maps (each carrying a `slideId` back-reference), and a `slideOrder`
// Y.Array giving document order.
function makeDeck(opts: {
    slideOrder: string[];
    slides: Record<string, string[]>;
    objects: Record<string, { slideId: string; type?: string; fontFamily?: string }>;
}): Y.Doc {
    const doc = new Y.Doc();
    doc.transact(() => {
        const slidesMap = doc.getMap('slides');
        const objectsMap = doc.getMap('objects');
        for (const [slideId, objectIds] of Object.entries(opts.slides)) {
            const s = new Y.Map();
            s.set('id', slideId);
            const arr = new Y.Array<string>();
            arr.push(objectIds);
            s.set('objectIds', arr);
            slidesMap.set(slideId, s);
        }
        for (const [objId, o] of Object.entries(opts.objects)) {
            const m = new Y.Map();
            m.set('id', objId);
            m.set('slideId', o.slideId);
            if (o.type) m.set('type', o.type);
            if (o.fontFamily) m.set('fontFamily', o.fontFamily);
            objectsMap.set(objId, m);
        }
        doc.getArray<string>('slideOrder').push(opts.slideOrder);
    });
    return doc;
}

const objectIdsOf = (doc: Y.Doc, slideId: string): string[] =>
    ((doc.getMap('slides').get(slideId) as Y.Map<unknown>).get('objectIds') as Y.Array<string>).toArray();

const slideIdOf = (doc: Y.Doc, objId: string): unknown =>
    (doc.getMap('objects').get(objId) as Y.Map<unknown>).get('slideId');

describe('normalizeDeck', () => {
    it('corrects a re-homed orphan slideId to the slide that now holds it', () => {
        const doc = makeDeck({
            slideOrder: ['s1', 's2'],
            slides: { s1: [], s2: [] },
            objects: { o1: { slideId: 's2' } }, // stale: names s2 but is in no slide's objectIds
        });
        normalizeDeck(doc);
        expect(objectIdsOf(doc, 's1')).toEqual(['o1']); // re-homed to the first slide in order
        expect(slideIdOf(doc, 'o1')).toBe('s1'); // back-reference reconciled to the new holder
    });

    it('corrects a dedupe-moved object slideId to the surviving slide', () => {
        const doc = makeDeck({
            slideOrder: ['s1', 's2'],
            slides: { s1: ['o1'], s2: ['o1'] }, // o1 double-referenced
            objects: { o1: { slideId: 's1' } }, // names the earlier, stripped slide
        });
        normalizeDeck(doc);
        expect(objectIdsOf(doc, 's1')).toEqual([]); // stripped from the earlier slide
        expect(objectIdsOf(doc, 's2')).toEqual(['o1']); // survivor
        expect(slideIdOf(doc, 'o1')).toBe('s2'); // back-reference reconciled to the survivor
    });

    it('writes nothing to a well-formed deck (idempotent)', () => {
        const doc = makeDeck({
            slideOrder: ['s1', 's2'],
            slides: { s1: ['o1'], s2: ['o2'] },
            objects: { o1: { slideId: 's1' }, o2: { slideId: 's2' } },
        });
        const before = Y.encodeStateAsUpdate(doc).length;
        normalizeDeck(doc);
        expect(Y.encodeStateAsUpdate(doc).length).toBe(before);
    });

    it('still backfills a default fontFamily on legacy text objects (regression guard)', () => {
        const doc = makeDeck({
            slideOrder: ['s1'],
            slides: { s1: ['o1'] },
            objects: { o1: { slideId: 's1', type: 'text' } }, // no fontFamily
        });
        normalizeDeck(doc);
        expect((doc.getMap('objects').get('o1') as Y.Map<unknown>).get('fontFamily')).toBe(EIGEN_FONTS[0].name);
    });
});
