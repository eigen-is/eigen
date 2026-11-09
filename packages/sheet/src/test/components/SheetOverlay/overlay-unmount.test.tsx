// The overlay leaves no work behind when the grid goes, such as on a remount for a new snapshot: a move over a cell
// arms the link card's debounce, and unmounting clears that timer, so no recipe runs on a workbook nobody shows.
import { expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
type Sheet = import('../../../state').Sheet;

const LINK_CARD_DEBOUNCE_MS = 800;
const data: Sheet[] = [{ id: 's1', name: 'One', order: 0, row: 10, column: 5, celldata: [], config: {} }];

test('unmounting clears the pending link card', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Workbook, { data })));
    const grid = container.querySelector('.sheet-cell-table');
    const area = container.querySelector('.sheet-cell-area');
    if (!grid || !area) throw new Error('no grid');
    area.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);

    const armed = spyOn(globalThis, 'setTimeout');
    const cleared = spyOn(globalThis, 'clearTimeout');
    await act(async () => {
        grid.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5 }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const index = armed.mock.calls.findIndex(([, delay]) => delay === LINK_CARD_DEBOUNCE_MS);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer = armed.mock.results[index]?.value;

    await act(async () => root.unmount());
    container.remove();
    expect(cleared.mock.calls.some(([id]) => id === timer)).toBe(true);
    armed.mockRestore();
    cleared.mockRestore();
});
