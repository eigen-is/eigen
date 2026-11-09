// What a host's render does to the workbook: it reaches it as props and costs one commit, no frame and no report, while
// a changed right or a card's new colour still reaches the grid. The host here passes a fresh hooks object on every
// render, as the app's inline literal does.
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { CommentCard } from '@workspace/lib/types/comments';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef, Profiler } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const frame = await import('../../../state/render/frame');
const overlay = await import('../../../state/modules/freeze');
type Sheet = import('../../../state').Sheet;
type Settings = import('../../../state').Settings;
type Selection = import('../../../state').Selection;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

// The grid skips a frame on a 0x0 box, and happy-dom has no layout.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

const twoSheets = (): Sheet[] => [
    { id: 's1', name: 'One', order: 0, row: 20, column: 5, celldata: [{ r: 0, c: 0, v: { v: 'x', m: 'x' } }] },
    { id: 's2', name: 'Two', order: 1, row: 20, column: 5, celldata: [] },
];

async function mountHost(props: Partial<Settings> = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const workbook = createRef<WorkbookInstance>();
    const data = twoSheets();
    const selections: Selection[] = [];
    const seen = { commits: 0, selections };
    const draws = spyOn(frame, 'drawFrame').mockImplementation(() => {});
    const overlayRenders = spyOn(overlay, 'computeOverlayRegions');
    const render = (next: Partial<Settings> = props) =>
        act(async () => {
            root.render(
                createElement(
                    Profiler,
                    {
                        id: 'workbook',
                        onRender: () => {
                            seen.commits += 1;
                        },
                    },
                    createElement(Workbook, {
                        ref: workbook,
                        data,
                        hooks: { afterSelectionChange: (_id, selection) => seen.selections.push(selection) },
                        ...next,
                    }),
                ),
            );
            await nextFrame();
        });
    await render();
    cleanup = async () => {
        draws.mockRestore();
        overlayRenders.mockRestore();
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector<HTMLDivElement>('#sheet-rich-text-editor');
    if (!input) throw new Error('no cell editor');
    input.focus();
    const press = (key: string) =>
        act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
            await nextFrame();
        });
    return { container, workbook, render, press, seen, draws, overlayRenders };
}

test('a host render commits once, repaints nothing, skips the overlay and reports nothing again', async () => {
    const { render, seen, draws, overlayRenders } = await mountHost();
    seen.commits = 0;
    seen.selections.length = 0;
    draws.mockClear();
    overlayRenders.mockClear();
    await render();
    expect(seen.commits).toBe(1);
    expect(draws).toHaveBeenCalledTimes(0);
    expect(overlayRenders).toHaveBeenCalledTimes(0);
    expect(seen.selections).toEqual([]);
});

test('a key calls the hook of the latest host render', async () => {
    const { render, press, seen } = await mountHost();
    const latest: Selection[] = [];
    await render({ hooks: { afterSelectionChange: (_id, selection) => latest.push(selection) } });
    seen.selections.length = 0;
    await press('ArrowDown');
    expect(seen.selections).toEqual([]);
    expect(latest.map((selection) => selection.row)).toEqual([[1, 1]]);
});

test('the workbook mounts with A1 selected', async () => {
    const { seen } = await mountHost();
    expect(seen.selections[0]).toMatchObject({ row: [0, 0], column: [0, 0] });
});

test("a comment card's new colour repaints the grid with it", async () => {
    const card = (color: string): CommentCard => ({ id: 'card', title: '', description: '', color });
    const { render, draws } = await mountHost({ commentCards: { card: card('#111111') } });
    draws.mockClear();
    await render({ commentCards: { card: card('#222222') } });
    expect(draws).toHaveBeenCalledTimes(1);
    const painted = draws.mock.calls[0][1];
    expect(painted.commentCards?.card.color).toBe('#222222');
});

test('a viewer given editor rights can edit at once, and one who loses them cannot', async () => {
    const { workbook, render, press } = await mountHost({ allowEdit: false });
    const a1 = () => workbook.current?.getAllSheets()[0].data?.[0]?.[0]?.v;
    await press('Delete');
    expect(a1()).toBe('x');
    await render({ allowEdit: true });
    await press('Delete');
    expect(a1() ?? null).toBeNull();
    await render({ allowEdit: false });
    await act(async () => workbook.current?.undo());
    expect(a1() ?? null).toBeNull();
});

// A sheet nobody visited, a copy included, has no selection to restore, and a key does nothing without one.
test('a sheet opened for the first time has a cursor the arrows move', async () => {
    const { container, workbook, press, seen } = await mountHost();
    const tab = [...container.querySelectorAll('[role="button"] span')].find((span) => span.textContent === 'Two');
    if (!tab?.parentElement) throw new Error('no tab');
    const tabElement = tab.parentElement;
    await act(async () => tabElement.click());
    expect(workbook.current?.getAllSheets().map((sheet) => sheet.id)).toEqual(['s1', 's2']);
    seen.selections.length = 0;
    await press('ArrowDown');
    expect(seen.selections.map((selection) => selection.row)).toEqual([[1, 1]]);
});

// The host publishes what this reports as the tab's cursor, so a peer's box of this tab follows the landing.
test("a peer's delete of the last row reports the selection where it landed, for the cursor peers see", async () => {
    const { workbook, seen } = await mountHost();
    await act(async () => {
        workbook.current?.revealSearchMatch({ sheetId: 's1', r: 19, c: 2 });
        await nextFrame();
    });
    seen.selections.length = 0;
    await act(async () => {
        workbook.current?.applyOp([
            { op: 'deleteRowCol', id: 's1', path: [], value: { type: 'row', start: 19, end: 19 } },
        ]);
        await nextFrame();
    });
    expect(seen.selections.map(({ row, column }) => [row, column])).toEqual([
        [
            [18, 18],
            [2, 2],
        ],
    ]);
});
