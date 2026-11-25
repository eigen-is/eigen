// The add-rows footer under the grid: Add puts the typed number of rows at the bottom, 50 when the field is empty, and a
// count it can't add says why instead of doing nothing.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const { MAX_SHEET_ROW_COUNT } = await import('../../../engine/defaults');
const { toast } = await import('sonner');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

const toastError = spyOn(toast, 'error');
const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, row: 10, column: 5, celldata: [], config: {} }];

let cleanup = async () => {};
afterEach(() => cleanup());

async function mount() {
    toastError.mockClear();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    await act(async () => root.render(createElement(Workbook, { ref, data })));
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const field = container.querySelector<HTMLInputElement>('input[placeholder="50"]');
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add');
    if (!field || !add) throw new Error('no add-rows footer');
    const addRows = async (count: string) => {
        await act(async () => {
            field.value = count;
            add.click();
        });
    };
    const rows = () => ref.current?.getAllSheets()[0]?.data?.length;
    return { addRows, rows };
}

test('Add puts the typed number of rows at the bottom, 50 when the field is empty', async () => {
    const { addRows, rows } = await mount();
    await addRows('3');
    expect(rows()).toBe(13);
    await addRows('');
    expect(rows()).toBe(63);
    expect(toastError).not.toHaveBeenCalled();
});

test('a count that is no number of rows it can add says so and adds nothing', async () => {
    const { addRows, rows } = await mount();
    for (const count of ['0', '-2', 'many', '2.5', ' ', '99999999']) {
        toastError.mockClear();
        await addRows(count);
        expect(rows()).toBe(10);
        expect(toastError.mock.calls).toEqual([[`Enter a number of rows from 1 to ${MAX_SHEET_ROW_COUNT}`]]);
    }
});

test('a count that takes the sheet past the row limit names the limit and adds nothing', async () => {
    const { addRows, rows } = await mount();
    await addRows(String(MAX_SHEET_ROW_COUNT));
    expect(rows()).toBe(10);
    expect(toastError.mock.calls).toEqual([[`${MAX_SHEET_ROW_COUNT} row limit exceeded`]]);
});
