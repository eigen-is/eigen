import { describe, expect, test } from 'bun:test';
import { peerOnFrame } from '../../../../components/vector/hooks/use-canvas-presence';

describe('peerOnFrame', () => {
    test('a peer on the same frame is visible', () => {
        expect(peerOnFrame({ frameId: 'f1' }, 'f1')).toBe(true);
    });

    test('a peer on another frame is hidden', () => {
        expect(peerOnFrame({ frameId: 'f2' }, 'f1')).toBe(false);
    });

    test('a peer that publishes no frame reads as the infinite canvas', () => {
        expect(peerOnFrame({}, '')).toBe(true);
        expect(peerOnFrame({}, 'f1')).toBe(false);
    });
});
