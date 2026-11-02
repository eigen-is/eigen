// A font slice that arrives changes what the grid's text measures, so the grid clears its measure caches and
// redraws whole. WebKit fires no loadingdone for the slices a canvas draw fetches, so one watcher per page listens
// to each face's own loaded promise, and waits for the set to be ready so that the faces of one load redraw each
// grid once. A grid that is gone is no longer listening, and no face holds on to it.

import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

const window = installHappyDom();

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

// A face still on its way, which counts the reactions chained on its loaded promise.
function loadingFace() {
    const load = deferred();
    const reactions = spyOn(load.promise, 'then');
    return { status: 'loading', loaded: load.promise, reactions, resolve: load.resolve, reject: load.reject };
}

// Two faces still on their way and one loaded before the grid mounted. The page's fonts belong to this file's
// happy-dom window, which goes when the file ends.
let faces: ReturnType<typeof loadingFace>[] = [];
let faceSet: object[] = [];
let ready = deferred();
beforeEach(() => {
    faces = [loadingFace(), loadingFace()];
    faceSet = [...faces, { status: 'loaded', loaded: Promise.resolve() }];
    ready = deferred();
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { ready: ready.promise, [Symbol.iterator]: () => faceSet[Symbol.iterator]() },
    });
});

// happy-dom lays nothing out, and the grid skips a frame on a 0 × 0 surface. Every happy-dom window shares one
// HTMLElement class, so the stubs and spies are undone after this file. Left in place, they made a later file
// measure every line as 600 pixels tall.
const elementPrototype = window.HTMLElement.prototype;
const realSizes = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['clientWidth', 'clientHeight']) {
    realSizes.set(key, Object.getOwnPropertyDescriptor(elementPrototype, key));
    Object.defineProperty(elementPrototype, key, { configurable: true, get: () => 600 });
}

const clears = spyOn(textModule, 'clearMeasureTextCache');
const draws = spyOn(frameModule, 'drawFrame').mockImplementation(() => {});

afterAll(() => {
    for (const [key, descriptor] of realSizes) {
        if (descriptor) Object.defineProperty(elementPrototype, key, descriptor);
        else Reflect.deleteProperty(elementPrototype, key);
    }
    clears.mockRestore();
    draws.mockRestore();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

// The watcher lives as long as the page, so each test ends with the set ready and the watcher idle.
let unmount = async () => {};
afterEach(async () => {
    await unmount();
    ready.resolve();
    await settle();
    clears.mockClear();
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

test('a face that arrives after the grid is gone redraws nothing', async () => {
    await mountGrid();
    await unmount();
    faces[0].resolve();
    ready.resolve();
    await settle();
    expect(draws).not.toHaveBeenCalled();
});

// Most faces, such as the CJK slices, never load in a session. A reaction per grid would keep every workbook the
// page ever opened alive through those pending promises.
test('mounting the grid again and again chains one reaction on each face', async () => {
    for (let mount = 0; mount < 3; mount++) {
        await mountGrid();
        await unmount();
    }
    await mountGrid();
    expect(faces.map((face) => face.reactions.mock.calls.length)).toEqual([1, 1]);
});

test('a listener that unsubscribed is not called', async () => {
    let calls = 0;
    const stop = textModule.watchFontFaces(() => calls++);
    stop();
    faces[0].resolve();
    ready.resolve();
    await settle();
    expect(calls).toBe(0);
});

test('one settled face clears the caches once and calls each listener once', async () => {
    const calls = [0, 0];
    const stops = [textModule.watchFontFaces(() => calls[0]++), textModule.watchFontFaces(() => calls[1]++)];
    faces[0].resolve();
    faces[1].resolve();
    ready.resolve();
    await settle();
    expect(clears).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([1, 1]);
    for (const stop of stops) stop();
});

test('a face added after the first subscribe is watched at the next one', async () => {
    const stops = [textModule.watchFontFaces(() => {})];
    const added = loadingFace();
    faceSet.push(added);
    stops.push(textModule.watchFontFaces(() => {}));
    expect(added.reactions).toHaveBeenCalledTimes(1);
    expect(faces.map((face) => face.reactions.mock.calls.length)).toEqual([1, 1]);
    for (const stop of stops) stop();
});
