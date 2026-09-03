import { expect, test } from 'bun:test';
import type { NewVectorElement } from '../../../../components/vector/hooks/use-canvas-doc';
import { homeToFrame } from '../../../../components/vector/tools/frame-scope';

const RECT: NewVectorElement = { type: 'rectangle' };

test('stamps the active frame onto a new element', () => {
    expect(homeToFrame(RECT, 'f1').frameId).toBe('f1');
});

test('the active frame WINS over a frameId riding in on the partial (a pasted element)', () => {
    // A paste carries the SOURCE frame's id; it must land in the frame being pasted into.
    const pasted: NewVectorElement = { type: 'rectangle', frameId: 'source' };
    expect(homeToFrame(pasted, 'target').frameId).toBe('target');
});

test('the infinite canvas stamps the empty string, never undefined', () => {
    expect(homeToFrame(RECT, '')).toEqual({ type: 'rectangle', frameId: '' });
});
