import { describe, expect, test } from 'bun:test';
import type { EigenClipboardElementsItem } from '../../types/clipboard';
import { buildElementsClipboardItem, readElementsClipboardItem, reanchorElements } from '../../vector/clipboard';
import { solidFill } from '../../vector/fill';
import { arrow, ellipse, image, linear, richtext, shape } from './element-factories';

describe('the elements clipboard item', () => {
    test('round-trips every kind through the reader', () => {
        const elements = [
            shape({ id: 'r', type: 'rectangle' }),
            shape({ id: 'd', type: 'diamond' }),
            ellipse({ id: 'e' }),
            image({ id: 'i', mediaName: 'pic.png' }),
            richtext({ id: 't', html: '<p>hi</p>' }),
            linear({ id: 'f', type: 'freedraw' }),
            linear({ id: 'l', type: 'line' }),
            arrow({ id: 'a' }),
        ];
        const item = buildElementsClipboardItem(elements, '');
        expect(readElementsClipboardItem([item as EigenClipboardElementsItem])?.elements).toEqual(elements);
    });

    test('rich text carries its own colour, html and padding', () => {
        const el = richtext({ id: 't', color: '#ff0080', html: '<p>x</p>', padding: 16, fill: solidFill('#eeeeee') });
        const item = buildElementsClipboardItem([el], '');
        expect(readElementsClipboardItem([item as EigenClipboardElementsItem])?.elements[0]).toEqual(el);
    });

    test('an arrow keeps its bindings verbatim, so the paste can remap them', () => {
        const el = arrow({ id: 'a', startBinding: JSON.stringify({ elementId: 'shape-1', fixedPoint: [0.5, 0.5] }) });
        const item = buildElementsClipboardItem([el], '');
        const read = readElementsClipboardItem([item as EigenClipboardElementsItem])?.elements[0];
        expect(read?.type === 'arrow' && read.startBinding).toBe(el.startBinding);
    });

    test('width and height are the selection box, so the mandatory-dimensions contract holds', () => {
        const item = buildElementsClipboardItem(
            [
                shape({ id: 'a', type: 'rectangle', x: 10, y: 10, width: 20, height: 20 }),
                shape({ id: 'b', type: 'rectangle', x: 50, y: 30, width: 10, height: 10 }),
            ],
            '',
        );
        expect(item?.width).toBe(50);
        expect(item?.height).toBe(30);
    });

    test('the source frame rides along', () => {
        expect(
            buildElementsClipboardItem([shape({ id: 'r', type: 'rectangle', frameId: 'f1' })], 'f1')?.sourceFrameId,
        ).toBe('f1');
    });

    test('a forged record is dropped, not written into a document', () => {
        const item: EigenClipboardElementsItem = {
            type: 'elements',
            width: 1,
            height: 1,
            sourceFrameId: '',
            elements: [{ id: 'x', type: 'nonsense' }, { nope: true }],
        };
        expect(readElementsClipboardItem([item])?.elements).toEqual([]);
    });

    test('a hostile field value is clamped by the reader, not trusted', () => {
        const item = buildElementsClipboardItem(
            [shape({ id: 'r', type: 'rectangle' })],
            '',
        ) as EigenClipboardElementsItem;
        item.elements[0].opacity = 5000;
        item.elements[0].strokeColor = 'url(#evil)';
        const el = readElementsClipboardItem([item])?.elements[0];
        expect(el?.opacity).toBe(100);
        expect(el?.strokeColor).toBe('#1e1e1e');
    });

    test('no elements item ⇒ null, so a foreign payload falls through', () => {
        expect(readElementsClipboardItem([])).toBeNull();
    });

    test('reanchorElements translates x/y and nothing else', () => {
        const el = shape({ id: 'r', type: 'rectangle', x: 10, y: 20, width: 5, height: 5 });
        expect(reanchorElements([el], 3, -4)[0]).toEqual({ ...el, x: 13, y: 16 });
    });

    test('an empty selection produces no item', () => {
        expect(buildElementsClipboardItem([], '')).toBeNull();
    });
});
