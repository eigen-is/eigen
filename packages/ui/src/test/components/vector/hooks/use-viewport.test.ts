import { afterAll, describe, expect, test } from 'bun:test';
import { fitFrameViewport } from '@workspace/lib/vector';
import { Window } from 'happy-dom';
import type { UseViewportOptions } from '../../../../components/vector/hooks/use-viewport';

// react-dom needs a DOM to render the hook harness into, and the hook itself needs a ResizeObserver
// (its re-fit trigger) and an rAF (its paint). The globals are removed again in afterAll so later test
// files see the plain bun environment. Recipe: lib's use-collab-doc test.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.DOMRect = window.DOMRect;
g.WheelEvent = window.WheelEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

// One callback list: a test resizes the container by re-stubbing its rect and firing them, which is
// exactly what the browser does.
const resizeCallbacks: (() => void)[] = [];
class FakeResizeObserver {
    constructor(callback: () => void) {
        resizeCallbacks.push(callback);
    }
    observe() {}
    disconnect() {}
}
g.ResizeObserver = FakeResizeObserver;
// The hook paints inside one rAF; running it inline keeps every assertion on the settled viewport.
g.requestAnimationFrame = (callback: () => void) => {
    callback();
    return 0;
};
g.cancelAnimationFrame = () => {};

afterAll(() => {
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.DOMRect = undefined;
    g.WheelEvent = undefined;
    g.ResizeObserver = undefined;
    g.requestAnimationFrame = undefined;
    g.cancelAnimationFrame = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useViewport } = await import('../../../../components/vector/hooks/use-viewport');

type Viewport = ReturnType<typeof useViewport>;
type WheelInput = { deltaX?: number; deltaY?: number; ctrlKey?: boolean; clientX?: number; clientY?: number };
const FRAME = { width: 1920, height: 1080 };

function Harness({ options, onRender }: { options: UseViewportOptions; onRender: (v: Viewport) => void }) {
    const viewport = useViewport(options);
    onRender(viewport);
    return createElement('div', { ref: viewport.containerRef });
}

function mount(options: UseViewportOptions, size: { width: number; height: number }) {
    let latest: Viewport | null = null;
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Harness, { options, onRender: (v) => (latest = v) })));
    const el = container.firstElementChild;
    if (!el) throw new Error('harness did not render its container');
    const rect = { ...size };
    el.getBoundingClientRect = () => new DOMRect(0, 0, rect.width, rect.height);
    const resize = (next: { width: number; height: number }) => {
        Object.assign(rect, next);
        act(() => {
            for (const callback of resizeCallbacks) callback();
        });
    };
    resize(size); // the first measure: the harness rendered before the rect stub existed
    return {
        get state() {
            if (!latest) throw new Error('hook has not rendered');
            return latest;
        },
        resize,
        wheel: ({ deltaX = 0, deltaY = 0, ctrlKey = false, clientX = 0, clientY = 0 }: WheelInput) => {
            const event = new WheelEvent('wheel', { deltaX, deltaY, cancelable: true });
            // happy-dom's WheelEvent drops the modifier and pointer fields of its init dict; the handler
            // reads ctrl (zoom vs pan) and the cursor as the zoom anchor.
            Object.defineProperties(event, {
                ctrlKey: { value: ctrlKey },
                clientX: { value: clientX },
                clientY: { value: clientY },
            });
            act(() => void el.dispatchEvent(event));
        },
        unmount: () => act(() => root.unmount()),
    };
}

describe('useViewport in frame mode', () => {
    const options: UseViewportOptions = { mode: 'frame', frame: FRAME, resetKey: 'f1' };

    test('opens fitted and re-fits when the container resizes', () => {
        const h = mount(options, { width: 1600, height: 1000 });
        expect(h.state.viewportRef.current).toEqual(fitFrameViewport({ width: 1600, height: 1000 }, FRAME));
        h.resize({ width: 1200, height: 700 });
        expect(h.state.viewportRef.current).toEqual(fitFrameViewport({ width: 1200, height: 700 }, FRAME));
        h.unmount();
    });

    test('a ctrl-wheel zoom, a wheel pan and a pinch all leave the viewport untouched', () => {
        const h = mount(options, { width: 1600, height: 1000 });
        const fitted = { ...h.state.viewportRef.current };

        h.wheel({ deltaY: -200, ctrlKey: true, clientX: 800, clientY: 500 });
        expect(h.state.viewportRef.current).toEqual(fitted);

        h.wheel({ deltaY: 200, deltaX: 120 });
        expect(h.state.viewportRef.current).toEqual(fitted);

        act(() => h.state.pinch(2, 800, 500, 40, 25));
        expect(h.state.viewportRef.current).toEqual(fitted);

        act(() => h.state.panBy(120, 90));
        expect(h.state.viewportRef.current).toEqual(fitted);

        // The zoom pill is hidden in frame mode; its action re-fits rather than jumping to 100%.
        act(() => h.state.resetZoom());
        expect(h.state.viewportRef.current).toEqual(fitted);
        h.unmount();
    });
});

describe('useViewport on the infinite canvas', () => {
    test('still zooms on ctrl-wheel and pans on a plain wheel', () => {
        const h = mount({ mode: 'infinite' }, { width: 1600, height: 1000 });
        const opened = { ...h.state.viewportRef.current };
        expect(opened.zoom).toBe(1);

        h.wheel({ deltaY: -200, ctrlKey: true, clientX: 800, clientY: 500 });
        expect(h.state.viewportRef.current.zoom).toBeGreaterThan(opened.zoom);

        const zoomed = { ...h.state.viewportRef.current };
        h.wheel({ deltaY: 200 });
        expect(h.state.viewportRef.current.scrollY).toBeLessThan(zoomed.scrollY);
        expect(h.state.viewportRef.current.zoom).toBe(zoomed.zoom);
        h.unmount();
    });
});
