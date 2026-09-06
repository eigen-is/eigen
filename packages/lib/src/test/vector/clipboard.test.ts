import { describe, expect, test } from 'bun:test';
import type { EigenClipboardElementsItem } from '../../types/clipboard';
import {
    buildElementsClipboardItem,
    pasteAnchorOffset,
    readClipboardTypography,
    readElementsClipboardItem,
    reanchorElements,
} from '../../vector/clipboard';
import { solidFill } from '../../vector/fill';
import { DUPLICATE_OFFSET } from '../../vector/geometry';
import { DEFAULT_RICHTEXT_PROPS } from '../../vector/types';
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

    test('a forged null record is skipped, not thrown on', () => {
        // A throw here lands inside the host's paste handler, AFTER its preventDefault — the paste
        // would vanish with no element and no browser fallback.
        const good = buildElementsClipboardItem([shape({ id: 'r', type: 'rectangle' })], '');
        const item: EigenClipboardElementsItem = {
            type: 'elements',
            width: 1,
            height: 1,
            sourceFrameId: '',
            // biome-ignore lint/suspicious/noExplicitAny: forging a wire the type forbids is the point
            elements: [null as any, 'nope' as any, ...(good?.elements ?? [])],
        };
        expect(readElementsClipboardItem([item])?.elements.map((el) => el.id)).toEqual(['r']);
    });

    test('a wire claiming more elements than any selection holds is capped', () => {
        // Every accepted record is read, validated and written into the doc in one transact, so the
        // count a forged wire declares has to have a ceiling.
        const one = buildElementsClipboardItem([shape({ id: 'r', type: 'rectangle' })], '');
        const record = one?.elements[0];
        if (!record) throw new Error('expected a stored record');
        const item: EigenClipboardElementsItem = {
            type: 'elements',
            width: 1,
            height: 1,
            sourceFrameId: '',
            elements: Array.from({ length: 12_000 }, () => ({ ...record })),
        };
        expect(readElementsClipboardItem([item])?.elements).toHaveLength(10_000);
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

describe('pasteAnchorOffset', () => {
    // BASE puts a shape at (0,0) 100×60, so its bounds centre is (50, 30).
    const set = [shape({ id: 'r', type: 'rectangle' })];
    const CENTRE = { x: 50, y: 30 };

    test('a paste into the frame it was copied from takes the duplicate step', () => {
        expect(pasteAnchorOffset(set, 'f1', 'f1', CENTRE)).toEqual({ dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET });
    });

    test('a paste into a DIFFERENT frame lands in place — frame-relative coords mean the same spot', () => {
        expect(pasteAnchorOffset(set, 'f1', 'f2', CENTRE)).toEqual({ dx: 0, dy: 0 });
    });

    test('a crossing re-anchors the bounding box on the viewport centre', () => {
        // Infinite canvas → frame, and the viewport centre is far from the copied bounds.
        expect(pasteAnchorOffset(set, '', 'f2', { x: 1050, y: 530 })).toEqual({ dx: 1000, dy: 500 });
        // Frame → infinite canvas, same rule.
        expect(pasteAnchorOffset(set, 'f1', '', { x: 1050, y: 530 })).toEqual({ dx: 1000, dy: 500 });
    });

    test('infinite → infinite re-anchors on the viewport centre when the copy came from elsewhere', () => {
        expect(pasteAnchorOffset(set, '', '', { x: 2450, y: 1830 })).toEqual({ dx: 2400, dy: 1800 });
    });

    test('a selection already under the viewport centre takes the duplicate step, not a no-op', () => {
        // THE bug: the re-anchor is ~0, so the copy landed pixel-exactly on the original and ⌘V looked
        // like a dead key. Below one duplicate step it behaves like ⌘D instead.
        expect(pasteAnchorOffset(set, '', '', CENTRE)).toEqual({ dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET });
        expect(pasteAnchorOffset(set, '', '', { x: CENTRE.x + 4, y: CENTRE.y - 3 })).toEqual({
            dx: DUPLICATE_OFFSET,
            dy: DUPLICATE_OFFSET,
        });
    });

    test('one duplicate step away is already a visible move, so the re-anchor stands', () => {
        const { dx, dy } = pasteAnchorOffset(set, '', '', { x: CENTRE.x + 200, y: CENTRE.y + 200 });
        expect({ dx, dy }).toEqual({ dx: 200, dy: 200 });
    });
});

describe('readClipboardTypography', () => {
    test('keeps the fields a peer write could have made', () => {
        expect(
            readClipboardTypography({
                textAlign: 'center',
                fontWeight: 'bold',
                fontStyle: 'italic',
                textDecoration: 'underline',
                verticalAlign: 'center',
                letterSpacing: 4,
                lineHeight: 1.5,
            }),
        ).toEqual({
            textAlign: 'center',
            fontWeight: 'bold',
            fontStyle: 'italic',
            textDecoration: 'underline',
            verticalAlign: 'center',
            letterSpacing: 4,
            lineHeight: 1.5,
        });
    });

    test('clamps tracking and leading to the bounds the document reader enforces', () => {
        const forged = readClipboardTypography({ letterSpacing: 1e9, lineHeight: 1e9 });
        expect([forged.letterSpacing, forged.lineHeight]).toEqual([200, 10]);
        const negative = readClipboardTypography({ letterSpacing: -1e9, lineHeight: -1e9 });
        expect([negative.letterSpacing, negative.lineHeight]).toEqual([-200, 0.5]);
    });

    test('falls back to the rich-text defaults for an unknown or missing value', () => {
        expect(readClipboardTypography({ textAlign: 'justify-all', lineHeight: Number.NaN })).toEqual({
            textAlign: DEFAULT_RICHTEXT_PROPS.textAlign,
            fontWeight: DEFAULT_RICHTEXT_PROPS.fontWeight,
            fontStyle: DEFAULT_RICHTEXT_PROPS.fontStyle,
            textDecoration: DEFAULT_RICHTEXT_PROPS.textDecoration,
            verticalAlign: DEFAULT_RICHTEXT_PROPS.verticalAlign,
            letterSpacing: DEFAULT_RICHTEXT_PROPS.letterSpacing,
            lineHeight: DEFAULT_RICHTEXT_PROPS.lineHeight,
        });
    });
});
