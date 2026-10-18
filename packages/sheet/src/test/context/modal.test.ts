// The anchored dialog (the cell-range picker) opens at a viewport point the caller
// computed, so ModalProvider clamps it on screen. Only the ordering decision is worth
// pinning: Math.max runs last, so a dialog larger than the viewport pins to the
// top-left margin instead of being pushed off the opposite edge.

import { describe, expect, it } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

// The module pulls in Radix, whose layout-effect shim picks a no-op when it first evaluates without a
// document, and later test files in this process would inherit it.
installHappyDom();

const { clampToViewport, VIEWPORT_MARGIN } = await import('../../context/modal');

const VIEWPORT = { width: 1200, height: 800 };

describe('clampToViewport', () => {
    it('a dialog taller than the viewport pins to the top-left margin, not off the far edge', () => {
        expect(clampToViewport({ left: 344, top: 216 }, { width: 380, height: 900 }, VIEWPORT)).toEqual({
            left: 344,
            top: VIEWPORT_MARGIN,
        });
    });
});
