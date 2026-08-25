import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import { handleCut } from '../../state/modules/clipboard';
import { contextFactory } from './factories/context';

// setPendingCopy uses document.createElement to extract plain text from HTML.
// globalThis is intentionally widened — Bun's test runtime has no DOM.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = {
    createElement: () => ({ innerHTML: '', innerText: '', textContent: '' }),
};
// sessionStorage is not available in Bun's test environment
g.sessionStorage = { setItem: () => {} };

describe('handleCut', () => {
    it('marks the copy range as cut and populates copy data', () => {
        const ctx = contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    data: [
                        [null, { m: 'A', v: 'A' }, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                    ],
                    order: 0,
                },
            ],
        }) as Context;
        ctx.pasteIsCut = false;

        handleCut(ctx);

        expect(ctx.pasteIsCut).toBe(true);
        expect(ctx.formulaRangeSelections).toHaveLength(1);
        expect(ctx.copyState?.dataSheetId).toBe('id_1');
    });

    it('does not set the cut flag when selection is empty', () => {
        const ctx = contextFactory({
            selections: [],
        }) as Context;
        ctx.pasteIsCut = false;

        handleCut(ctx);

        expect(ctx.pasteIsCut).toBe(false);
    });
});
