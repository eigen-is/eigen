import { describe, expect, test } from 'bun:test';
import { activateSheet, addSheet, deleteSheet, scroll, setSheetName, setSheetOrder } from '../../api/workbook';
import type { Context } from '../../context';
import { contextFactory, selectionFactory } from '../factories/context';

// Mock DOM for tests. globalThis is intentionally widened — Bun's test runtime
// has no DOM by default and these mocks are scoped to this test file.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
(globalThis as any).document = {
    createElement: (_tag: string) => ({
        innerHTML: '',
        style: {},
        setAttribute: () => {},
        getAttribute: () => null,
        scrollLeft: 0,
        scrollTop: 0,
    }),
};

describe('sheet/core/api/workbook', () => {
    const getContext = () =>
        contextFactory({
            luckysheet_select_save: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('addSheet', () => {
        const ctx = getContext();
        // Settings is Required<…> for the runtime call, but every other field has
        // a default in the addSheet implementation — only the four exercised here
        // matter for this assertion. biome-ignore: Partial<Settings> would require
        // touching the source-of-truth Settings type, out of scope for this test.
        // biome-ignore lint/suspicious/noExplicitAny: test fixture covers happy path
        const settings: any = {
            allowEdit: true,
            row: 60,
            column: 84,
            generateSheetId: () => 'id_3',
        };
        addSheet(ctx, settings);
        expect(ctx.luckysheetfile.length).toBe(3);
        expect(ctx.luckysheetfile[2].id).toBe('id_3');
    });

    test('deleteSheet', () => {
        const ctx = getContext();
        deleteSheet(ctx);
        expect(ctx.luckysheetfile.length).toBe(1);
        deleteSheet(ctx, { id: 'id_2' });
        expect(ctx.luckysheetfile.length).toBe(0);
    });

    test('activateSheet', () => {
        const ctx = getContext();
        activateSheet(ctx);
        expect(ctx.currentSheetId).toBe('id_1');
        activateSheet(ctx, { id: 'id_2' });
        expect(ctx.currentSheetId).toBe('id_2');
    });

    test('setSheetName', () => {
        const ctx = getContext();
        setSheetName(ctx, 'winner');
        expect(ctx.luckysheetfile[0].name).toBe('winner');
        setSheetName(ctx, 'winner', { id: 'id_2' });
        expect(ctx.luckysheetfile[1].name).toBe('winner');
    });

    test('setSheetOrder', () => {
        const ctx = getContext();
        setSheetOrder(ctx, { id_1: 2, id_2: 1 });
        expect(ctx.luckysheetfile[0].order).toBe(1);
        expect(ctx.luckysheetfile[1].order).toBe(0);
        setSheetOrder(ctx, { id_1: 1, id_2: 2 });
        expect(ctx.luckysheetfile[0].order).toBe(0);
        expect(ctx.luckysheetfile[1].order).toBe(1);
    });

    test('scroll', () => {
        const ctx = getContext();
        const scrollbarX = document.createElement('div');
        scrollbarX.scrollLeft = 0;
        const scrollbarY = document.createElement('div');
        scrollbarY.scrollTop = 0;
        scroll(ctx, scrollbarX, scrollbarY, { targetRow: 2 });
        expect(scrollbarY.scrollTop).toBe(40);
        scroll(ctx, scrollbarX, scrollbarY, { targetColumn: 2 });
        expect(scrollbarX.scrollLeft).toBe(148);
        scroll(ctx, scrollbarX, scrollbarY, { scrollTop: 100 });
        expect(scrollbarY.scrollTop).toBe(100);
        scroll(ctx, scrollbarX, scrollbarY, { scrollLeft: 99 });
        expect(scrollbarX.scrollLeft).toBe(99);
    });
});
