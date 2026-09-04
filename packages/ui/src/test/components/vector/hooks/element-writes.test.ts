import { describe, expect, test } from 'bun:test';
import { readVectorFromDoc, serializeBinding } from '@workspace/lib/vector';
import * as Y from 'yjs';
import { duplicateElementsInDoc } from '../../../../components/vector/hooks/element-writes';

function docWith(elements: Record<string, unknown>[]): Y.Doc {
    const doc = new Y.Doc();
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
