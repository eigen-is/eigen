// An edit that would leave a validation rule more ranges than a rule may hold is refused whole: every peer, the server
// and a reload would drop such a rule. Here A1 holds a rule and A2 none, and A1:A2 pasted down column C would land the
// rule on every other row. The author keeps the workbook as it was and sees why, and no batch reaches a peer.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;
type Op = import('../../../state').Op;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const ROWS = 17_000;
const RULE = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    Reflect.deleteProperty(document, 'execCommand');
    await cleanup?.();
    cleanup = undefined;
});

async function key(target: HTMLElement, init: KeyboardEventInit) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
}

test('a paste that would make a rule too complex changes nothing, sends nothing and says why', async () => {
    document.execCommand = () => true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const batches: Op[][] = [];
    const data: Sheet[] = [
        {
            id: 's1',
            name: 'One',
            order: 0,
            status: 1,
            row: ROWS,
            column: 4,
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a' } }],
            config: {},
            dataValidations: { v: { ranges: [{ row: [0, 0], column: [0, 0] }], rule: RULE } },
        },
    ];
    await act(async () => {
        root.render(
            createElement(Workbook, {
                ref: workbook,
                data,
                showToolbar: false,
                showFormulaBar: false,
                onOp: (ops: Op[]) => batches.push(ops),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    input.focus();
    const sheet = () => workbook.current?.getAllSheets()[0];

    await act(async () => workbook.current?.setSelection([{ row: [0, 1], column: [0, 0] }]));
    await key(input, { key: 'c', code: 'KeyC', ctrlKey: true });
    const clipboardData = new DataTransfer();
    await act(async () => {
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    });
    expect(clipboardData.getData('text/html')).toContain('<table');

    await act(async () => workbook.current?.setSelection([{ row: [0, ROWS - 1], column: [2, 2] }]));
    const sent = batches.length;
    await key(input, { key: 'v', code: 'KeyV', ctrlKey: true });
    await act(async () => {
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });

    expect(batches.length).toBe(sent);
    expect(sheet()?.dataValidations).toEqual(data[0].dataValidations);
    expect(sheet()?.data?.[0]?.[2] ?? null).toBeNull();
    // The refused paste left no undo step, so an undo has nothing to send.
    await act(async () => workbook.current?.undo());
    expect(batches.length).toBe(sent);
    // The warning dialog opens a moment after the refusal.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(document.body.textContent).toContain('This edit would make a data validation rule too complex.');
});
