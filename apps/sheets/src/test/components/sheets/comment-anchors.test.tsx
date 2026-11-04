import { afterEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('@workspace/sheet');
const { anchoredComments, stripCommentCard } = await import('../../../components/sheets/comment-anchors');
type Sheet = import('@workspace/sheet').Sheet;
type WorkbookInstance = import('@workspace/sheet').WorkbookInstance;

// Card c1 sits on the first tab's B2 and on the second tab's C3, which is not the open tab.
function sheets(): Sheet[] {
    return [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: 5,
            column: 5,
            celldata: [{ r: 1, c: 1, v: { v: 'a', commentCardIds: ['c1', 'c2'] } }],
            config: {},
        },
        {
            id: 's2',
            name: 'Two',
            order: 1,
            row: 5,
            column: 5,
            celldata: [
                { r: 2, c: 2, v: { v: 'b', commentCardIds: ['c1'] } },
                { r: 0, c: 0, v: { v: 'c', commentCardIds: ['c3'] } },
            ],
            config: {},
        },
    ];
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

async function mountWorkbook(): Promise<WorkbookInstance> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    await act(async () => {
        root.render(createElement(Workbook, { ref, data: sheets(), showToolbar: false, showFormulaBar: false }));
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    if (!ref.current) throw new Error('workbook did not mount');
    return ref.current;
}

const idsAt = (workbook: WorkbookInstance, sheetId: string, r: number, c: number) =>
    workbook.getFlowdata(sheetId)?.[r]?.[c]?.commentCardIds;

describe('anchoredComments', () => {
    test('a card anchored only on a tab that is not open is in use', async () => {
        const workbook = await mountWorkbook();
        const active = anchoredComments(workbook.getAllSheets());
        expect([...active.ids].sort()).toEqual(['c1', 'c2', 'c3']);
        expect(active.anchorTexts.get('c3')).toBe('Cell A1');
        // A card on several cells takes the first sheet's cell as its anchor text.
        expect(active.anchorTexts.get('c1')).toBe('Cell B2');
    });
});

describe('stripCommentCard', () => {
    test('takes the card off every cell of every sheet, as one undo step', async () => {
        const workbook = await mountWorkbook();
        await act(async () => stripCommentCard(workbook, 'c1'));
        expect(idsAt(workbook, 's1', 1, 1)).toEqual(['c2']);
        expect(idsAt(workbook, 's2', 2, 2)).toEqual([]);
        expect(anchoredComments(workbook.getAllSheets()).ids.has('c1')).toBe(false);

        await act(async () => workbook.undo());
        expect(idsAt(workbook, 's1', 1, 1)).toEqual(['c1', 'c2']);
        expect(idsAt(workbook, 's2', 2, 2)).toEqual(['c1']);
    });

    test('leaves no anchor anywhere after a tab was duplicated', async () => {
        const workbook = await mountWorkbook();
        const tab = [...document.querySelectorAll('[role="button"]')].find((el) => el.textContent?.includes('One'));
        await act(async () => {
            tab?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        const duplicate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
            (item) => item.textContent === 'Duplicate',
        );
        if (!duplicate) throw new Error('no Duplicate item');
        await act(async () => duplicate.click());
        expect(workbook.getAllSheets()).toHaveLength(3);

        await act(async () => stripCommentCard(workbook, 'c1'));
        const stored = workbook
            .getAllSheets()
            .flatMap((sheet) => [...(sheet.data ?? []).flat(), ...(sheet.celldata ?? []).map(({ v }) => v)]);
        expect(stored.some((cell) => cell?.commentCardIds?.includes('c1'))).toBe(false);
    });
});
