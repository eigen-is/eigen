// A font slice that arrives changes what the grid's text measures, so the grid clears its measure caches and
// redraws whole. WebKit fires no loadingdone for the slices a canvas draw fetches, so the grid listens to each
// face's own loaded promise, and waits for the set to be ready so that the faces of one load redraw it once. A
// face that settles after the grid is gone does nothing.

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const textModule = await import('../../../state/modules/text');
const frameModule = await import('../../../state/render/frame');

// A promise the test settles, as the network would.
function deferred() {
    const settled = { promise: Promise.resolve(), resolve: () => {}, reject: () => {} };
    settled.promise = new Promise<void>((resolve, reject) => {
        settled.resolve = resolve;
        settled.reject = () => reject(new Error('the slice failed to load'));
    });
    settled.promise.catch(() => {});
    return settled;
}

// Two faces still on their way and one loaded before the grid mounted. The page's fonts belong to this file's
// happy-dom window, which goes when the file ends.
let faces: ReturnType<typeof deferred>[] = [];
let ready = deferred();
beforeEach(() => {
    faces = [deferred(), deferred()];
    ready = deferred();
    const faceSet = [
        ...faces.map((face) => ({ status: 'loading', loaded: face.promise })),
        { status: 'loaded', loaded: Promise.resolve() },
    ];
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { ready: ready.promise, [Symbol.iterator]: () => faceSet[Symbol.iterator]() },
    });
});

// happy-dom lays nothing out, and the grid skips a frame on a 0 × 0 surface.
for (const key of ['clientWidth', 'clientHeight']) {
    Object.defineProperty(window.HTMLElement.prototype, key, { configurable: true, get: () => 600 });
}

const clears = spyOn(textModule, 'clearMeasureTextCache');
const draws = spyOn(frameModule, 'drawFrame').mockImplementation(() => {});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

let unmount = async () => {};
afterEach(async () => {
    await unmount();
});

async function mountGrid() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(Workbook, {
                data: [{ id: 's1', name: 'One', order: 0, row: 20, column: 5, celldata: [], config: {} }],
                showToolbar: false,
                showFormulaBar: false,
            }),
        );
    });
    clears.mockClear();
    draws.mockClear();
    unmount = async () => {
        unmount = async () => {};
        await act(async () => root.unmount());
        container.remove();
    };
}

test('faces that arrive while the set still loads clear the measure caches once and redraw the grid once', async () => {
    await mountGrid();
    faces[0].resolve();
    await settle();
    faces[1].resolve();
    await settle();
    expect(draws).not.toHaveBeenCalled();

    ready.resolve();
    await settle();
    expect(clears).toHaveBeenCalledTimes(1);
    expect(draws).toHaveBeenCalledTimes(1);
});

// A face that failed to load still changes the text: it now draws in the next face of its stack.
test('a face that fails to load redraws the grid too', async () => {
    await mountGrid();
    faces[1].reject();
    ready.resolve();
    await settle();
    expect(clears).toHaveBeenCalledTimes(1);
    expect(draws).toHaveBeenCalledTimes(1);
});

test('a face that arrives after the grid is gone does nothing', async () => {
    await mountGrid();
    await unmount();
    faces[0].resolve();
    ready.resolve();
    await settle();
    expect(clears).not.toHaveBeenCalled();
    expect(draws).not.toHaveBeenCalled();
});
