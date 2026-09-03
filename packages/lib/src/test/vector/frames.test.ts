import { describe, expect, test } from 'bun:test';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH } from '../../slides/types';
import { elementsInFrame, FRAME_FIELDS, FRAME_HEIGHT, FRAME_WIDTH } from '../../vector/frames';
import { shape } from './element-factories';

describe('frames', () => {
    // The one fact a test can hold that the declarations don't: slide space and frame space are the same
    // numbers, owned here.
    test('slides reads the frame constants', () => {
        expect([SLIDE_BASE_WIDTH, SLIDE_BASE_HEIGHT]).toEqual([FRAME_WIDTH, FRAME_HEIGHT]);
    });
});

describe('elementsInFrame', () => {
    test('selects exactly the elements homed to that frame', () => {
        const els = [
            shape({ id: 'a', type: 'rectangle', frameId: 'f1' }),
            shape({ id: 'b', type: 'rectangle', frameId: 'f2' }),
            shape({ id: 'c', type: 'rectangle' }),
        ];
        expect(elementsInFrame(els, 'f1').map((e) => e.id)).toEqual(['a']);
        expect(elementsInFrame(els, '').map((e) => e.id)).toEqual(['c']);
    });
});

test('FRAME_FIELDS is the stored key allow-list, and excludes the constant size', () => {
    expect(FRAME_FIELDS).toEqual(['id', 'index', 'name', 'background']);
});
