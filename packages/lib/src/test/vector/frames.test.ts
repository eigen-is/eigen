import { describe, expect, test } from 'bun:test';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH } from '../../slides/types';
import { FRAME_HEIGHT, FRAME_WIDTH } from '../../vector/frames';

describe('frames', () => {
    // The one fact a test can hold that the declarations don't: slide space and frame space are the same
    // numbers, owned here.
    test('slides reads the frame constants', () => {
        expect([SLIDE_BASE_WIDTH, SLIDE_BASE_HEIGHT]).toEqual([FRAME_WIDTH, FRAME_HEIGHT]);
    });
});
