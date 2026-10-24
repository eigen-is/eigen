import { describe, expect, test } from 'bun:test';
import { sampleChartSpec } from '@workspace/lib/charts';
import type { VectorElement } from '@workspace/lib/vector';
import {
    DEFAULT_ELEMENT_PROPS,
    ELEMENT_KINDS,
    readVectorFromDoc,
    VECTOR_STYLE_DEFAULTS,
    writeElementInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { replaceElementInDoc } from '../../../../components/vector/hooks/element-writes';
import { convertElementToShapes, selectionShapes } from '../../../../components/vector/hooks/selection-ops';

const BASE = { ...DEFAULT_ELEMENT_PROPS, x: 0, y: 0, width: 640, height: 400, angle: 0, index: 'a0', seed: 3 };

const chart = (id: string, spec = JSON.stringify(sampleChartSpec('column'))): VectorElement => ({
    ...BASE,
    ...ELEMENT_KINDS.chart.defaults(VECTOR_STYLE_DEFAULTS),
    id,
    type: 'chart',
    chart: spec,
});

const rectangle: VectorElement = {
    ...BASE,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    id: 'r1',
    type: 'rectangle',
};

const byId = (elements: VectorElement[]) => new Map(elements.map((el) => [el.id, el]));

describe('selectionShapes', () => {
    test('offers Convert to shapes for a selection of one chart that draws', () => {
        expect(selectionShapes(['c1'], byId([chart('c1')])).length).toBeGreaterThan(0);
    });

    test('offers nothing for a chart that draws its placeholder, another kind, or more than one element', () => {
        expect(selectionShapes(['c1'], byId([chart('c1', '{"type":')]))).toEqual([]);
        expect(selectionShapes(['r1'], byId([rectangle]))).toEqual([]);
        expect(selectionShapes(['c1', 'c2'], byId([chart('c1'), chart('c2')]))).toEqual([]);
        expect(selectionShapes(['c1', 'r1'], byId([chart('c1'), rectangle]))).toEqual([]);
    });
});

describe('convertElementToShapes', () => {
    test('one undo step, and the new elements are selected', () => {
        const doc = new Y.Doc();
        writeElementInDoc(doc, chart('c1'), 'a0', VECTOR_STYLE_DEFAULTS, 'c1');
        const undoManager = new Y.UndoManager(doc.getMap('elements'));
        const shapes = selectionShapes(['c1'], byId(readVectorFromDoc(doc).elements));
        let selection: string[] = ['c1'];
        convertElementToShapes(
            'c1',
            shapes,
            (id, partials) => replaceElementInDoc(doc, id, partials, VECTOR_STYLE_DEFAULTS),
            (ids) => {
                selection = ids;
            },
            undoManager,
        );
        expect(selection).toHaveLength(shapes.length);
        expect(readVectorFromDoc(doc).elements.map((el) => el.id)).toEqual(selection);
        expect(undoManager.undoStack).toHaveLength(1);
    });
});
