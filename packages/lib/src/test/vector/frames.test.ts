import { describe, expect, test } from 'bun:test';
import { SLIDE_BASE_HEIGHT, SLIDE_BASE_WIDTH } from '../../slides/types';
import { FRAME_ASPECT_RATIO, FRAME_HEIGHT, FRAME_WIDTH } from '../../vector/frames';

describe('frames', () => {
    test('a frame is 16:9 at 1920x1080 and slides reads the same constants', () => {
        expect([FRAME_WIDTH, FRAME_HEIGHT]).toEqual([1920, 1080]);
        expect(FRAME_ASPECT_RATIO).toBeCloseTo(16 / 9, 10);
        expect([SLIDE_BASE_WIDTH, SLIDE_BASE_HEIGHT]).toEqual([FRAME_WIDTH, FRAME_HEIGHT]);
    });
});
