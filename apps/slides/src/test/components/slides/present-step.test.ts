import { describe, expect, test } from 'bun:test';
import { presentStep } from '../../../components/slides/present-mode';

describe('presentStep', () => {
    test('a click advances', () => {
        expect(presentStep(0, 3, 1)).toBe(1);
    });

    test('a click past the last slide leaves present mode', () => {
        expect(presentStep(2, 3, 1)).toBe(-1);
    });

    test('going back from the first slide stays put — it never exits', () => {
        expect(presentStep(0, 3, -1)).toBe(0);
    });

    test('an empty deck has nowhere to go', () => {
        expect(presentStep(0, 0, 1)).toBe(-1);
    });
});
