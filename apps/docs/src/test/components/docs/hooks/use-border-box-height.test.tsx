// An element's height as drawn is its border box's, measured on mount and again on each resize of that box. A pause
// keeps the last height, and its end measures again. Another element is measured anew.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { useBorderBoxHeight } = await import('../../../../components/docs/hooks/use-border-box-height');

// Every live ResizeObserver, with the box it observes, so a test resizes only what watches that box.
const observers = new Set<{ owner: object; box: ResizeObserverBoxOptions; notify: () => void }>();
globalThis.ResizeObserver = class {
    readonly #callback: ResizeObserverCallback;
    public constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
    }
    public observe(_target: Element, options?: ResizeObserverOptions) {
        observers.add({ owner: this, box: options?.box ?? 'content-box', notify: () => this.#callback([], this) });
    }
    public unobserve() {}
    public disconnect() {
        for (const entry of observers) if (entry.owner === this) observers.delete(entry);
    }
};
const resized = (box: ResizeObserverBoxOptions) =>
    act(async () => {
        for (const observer of [...observers]) if (observer.box === box) observer.notify();
    });

let unmount = async () => {};
afterEach(() => unmount());

// An element whose offsetHeight is what `drawn.height` holds.
function drawnElement(height: number) {
    const element = document.createElement('div');
    const drawn = { height };
    Object.defineProperty(element, 'offsetHeight', { configurable: true, get: () => drawn.height });
    return { element, drawn };
}

let height: number | undefined;
let setPaused: (paused: boolean) => void = () => {};
let setElement: (element: HTMLElement | null) => void = () => {};
function Probe({ initial }: { initial: HTMLElement | null }) {
    const [paused, pause] = useState(false);
    const [element, choose] = useState(initial);
    setPaused = pause;
    setElement = choose;
    height = useBorderBoxHeight(element, paused);
    return null;
}

async function mount(initial: HTMLElement | null) {
    ({ unmount } = await renderInDocument(createElement(Probe, { initial })));
}

test('the height is the border box as drawn, measured again when that box resizes', async () => {
    const { element, drawn } = drawnElement(100);
    await mount(element);
    expect(height).toBe(100);
    drawn.height = 140;
    await resized('content-box');
    expect(height).toBe(100);
    await resized('border-box');
    expect(height).toBe(140);
});

test('a pause keeps the last height, and its end measures again', async () => {
    const { element, drawn } = drawnElement(100);
    await mount(element);
    await act(async () => setPaused(true));
    drawn.height = 140;
    await resized('border-box');
    expect(height).toBe(100);
    await act(async () => setPaused(false));
    expect(height).toBe(140);
});

test('no element has no height, and another element is measured anew', async () => {
    await mount(null);
    expect(height).toBeUndefined();
    const first = drawnElement(100);
    await act(async () => setElement(first.element));
    expect(height).toBe(100);
    const second = drawnElement(60);
    await act(async () => setElement(second.element));
    first.drawn.height = 200;
    await resized('border-box');
    expect(height).toBe(60);
});
