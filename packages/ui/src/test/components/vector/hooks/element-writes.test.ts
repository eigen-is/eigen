import { describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import {
    convertToShapes,
    readVectorFromDoc,
    serializeBinding,
    VECTOR_STYLE_DEFAULTS,
    type VectorElement,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { sealed } from '../../../../components/properties-panel/property-gesture';
import { duplicateElementsInDoc, replaceElementInDoc } from '../../../../components/vector/hooks/element-writes';
import { addFrameInDoc } from '../../../../components/vector/hooks/frame-writes';

function docWith(elements: Record<string, unknown>[], doc = new Y.Doc()): Y.Doc {
    doc.transact(() => {
        const map = doc.getMap('elements');
        for (const fields of elements) {
            const element = new Y.Map();
            for (const [key, value] of Object.entries(fields)) element.set(key, value);
            map.set(String(fields.id), element);
        }
    });
    return doc;
}

const RECT = { type: 'rectangle', width: 100, height: 60, x: 0, y: 0, index: 'a0', seed: 7 };

describe('duplicateElementsInDoc', () => {
    test('a copy starts with no comment cards — they belong to the element that was commented on', () => {
        const doc = docWith([{ ...RECT, id: 'r1', commentCardIds: '["c1","c2"]' }]);
        const [cloneId] = duplicateElementsInDoc(doc, ['r1'], 10, 10);
        const byId = new Map(readVectorFromDoc(doc).elements.map((el) => [el.id, el]));
        expect(byId.get('r1')?.commentCardIds).toBe('["c1","c2"]');
        expect(byId.get(cloneId)?.commentCardIds).toBe('');
    });

    test('clones offset, stack on top and take a fresh seed', () => {
        const doc = docWith([{ ...RECT, id: 'r1', x: 20, y: 30 }]);
        const [cloneId] = duplicateElementsInDoc(doc, ['r1'], 10, -5);
        const clone = readVectorFromDoc(doc).elements.at(-1);
        expect(clone?.id).toBe(cloneId);
        expect(clone).toMatchObject({ x: 30, y: 25 });
        expect(clone?.type === 'rectangle' && clone.seed).not.toBe(7);
    });

    test('an arrow bound inside the duplicated set follows its clone; a binding outside it clears', () => {
        const inside = serializeBinding({ elementId: 'r1', fixedPoint: [0.5, 0.5] });
        const outside = serializeBinding({ elementId: 'r2', fixedPoint: [0.5, 0.5] });
        const doc = docWith([
            { ...RECT, id: 'r1' },
            { ...RECT, id: 'r2', index: 'a1' },
            {
                type: 'arrow',
                id: 'a1',
                index: 'a2',
                width: 100,
                height: 0,
                x: 0,
                y: 0,
                points: '[[0,0],[100,0]]',
                startBinding: inside,
                endBinding: outside,
            },
        ]);
        const [rectClone, arrowClone] = duplicateElementsInDoc(doc, ['r1', 'a1'], 0, 0);
        const clone = readVectorFromDoc(doc).elements.find((el) => el.id === arrowClone);
        expect(clone?.type === 'arrow' && clone.startBinding).toBe(
            serializeBinding({ elementId: rectClone, fixedPoint: [0.5, 0.5] }),
        );
        expect(clone?.type === 'arrow' && clone.endBinding).toBe('');
    });
});

const CHART = {
    type: 'chart',
    id: 'c1',
    x: 40,
    y: 20,
    width: 640,
    height: 400,
    index: 'a1',
    seed: 5,
    chart: JSON.stringify(sampleChartSpec('column')),
};

function shapesOfChart(doc: Y.Doc): VectorElement[] {
    const chart = readVectorFromDoc(doc).elements.find((el) => el.id === 'c1');
    if (!chart) throw new Error('expected the chart');
    return convertToShapes(chart);
}

function replaceChart(doc: Y.Doc, shapes: VectorElement[]): string[] {
    return replaceElementInDoc(doc, 'c1', shapes, VECTOR_STYLE_DEFAULTS);
}

const storedIds = (doc: Y.Doc): string[] => [...doc.getMap('elements').keys()].sort();

describe('replaceElementInDoc', () => {
    test('the shapes take the chart z slot, between its neighbours, in their own order', () => {
        const doc = docWith([{ ...RECT, id: 'below', index: 'a0' }, CHART, { ...RECT, id: 'above', index: 'a2' }]);
        const shapes = shapesOfChart(doc);
        const ids = replaceChart(doc, shapes);
        expect(ids).toHaveLength(shapes.length);
        expect(readVectorFromDoc(doc).elements.map((el) => el.id)).toEqual(['below', ...ids, 'above']);
    });

    test('fresh ids, the given seeds and the chart frame on every shape', () => {
        const frames = new Y.Doc();
        const frameId = addFrameInDoc(frames, null);
        const doc = docWith([{ ...CHART, frameId }], frames);
        const shapes = shapesOfChart(doc);
        const ids = replaceChart(doc, shapes);
        const elements = doc.getMap('elements');
        expect(elements.has('c1')).toBe(false);
        for (const [i, id] of ids.entries()) {
            const stored = elements.get(id);
            if (!(stored instanceof Y.Map)) throw new Error('expected a stored element');
            expect(id.startsWith('c1:')).toBe(false);
            expect(stored.get('id')).toBe(id);
            expect(stored.get('seed')).toBe(shapes[i].seed);
            expect(stored.get('frameId')).toBe(frameId);
        }
    });

    test('one undo step: undo brings the chart back, redo the shapes', () => {
        const doc = docWith([CHART]);
        const undoManager = new Y.UndoManager(doc.getMap('elements'));
        const ids = sealed(undoManager, () => replaceChart(doc, shapesOfChart(doc)));
        expect(undoManager.undoStack).toHaveLength(1);
        undoManager.undo();
        expect(storedIds(doc)).toEqual(['c1']);
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ type: 'chart', index: 'a1', x: 40 });
        undoManager.redo();
        expect(storedIds(doc)).toEqual([...ids].sort());
    });

    test('an arrow bound to the chart keeps its endpoints and loses the binding, as on delete', () => {
        const binding = serializeBinding({ elementId: 'c1', fixedPoint: [0, 0.5] });
        const arrow = {
            type: 'arrow',
            id: 'ar',
            index: 'a2',
            x: -100,
            y: 220,
            width: 140,
            height: 0,
            points: '[[0,0],[140,0]]',
            endBinding: binding,
        };
        const doc = docWith([CHART, arrow]);
        replaceChart(doc, shapesOfChart(doc));
        const stored = readVectorFromDoc(doc).elements.find((el) => el.id === 'ar');
        expect(stored).toMatchObject({ x: -100, y: 220, width: 140, points: '[[0,0],[140,0]]', endBinding: '' });
    });

    test('a chart with a malformed index converts on top rather than throwing', () => {
        const doc = docWith([
            { ...CHART, index: 'not an index' },
            { ...RECT, id: 'r1', index: 'a3' },
        ]);
        const ids = replaceChart(doc, shapesOfChart(doc));
        expect(readVectorFromDoc(doc).elements.map((el) => el.id)).toEqual(['r1', ...ids]);
    });

    test('a missing element writes nothing', () => {
        const doc = docWith([CHART]);
        const shapes = shapesOfChart(doc);
        expect(replaceElementInDoc(doc, 'gone', shapes, VECTOR_STYLE_DEFAULTS)).toEqual([]);
        expect(storedIds(doc)).toEqual(['c1']);
    });
});
