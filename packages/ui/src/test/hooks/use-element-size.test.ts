import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';

// happy-dom lays nothing out, so the test resizes a node by re-stubbing its rect and firing the
// observers itself — the same trick as the viewport and element-layer tests.
const resizeCallbacks: (() => void)[] = [];
installHappyDom({ onResizeObserver: (callback) => resizeCallbacks.push(callback) });

const { act, createElement, useRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useElementSize } = await import('../../hooks/use-element-size');

type Size = { width: number; height: number };

function mount() {
    let latest: Size | null = null;
    let external: Element | null = null;
    function Harness() {
        const ref = useRef<HTMLDivElement | null>(null);
        const [setElement, size] = useElementSize(ref);
        latest = size;
        external = ref.current;
        return createElement('div', { ref: setElement });
    }
    // Drop the previous test's disconnected observers, which would now fire with no entries at all.
    resizeCallbacks.length = 0;
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));
    const el = container.firstElementChild!;
    return {
        el,
        get size() {
            if (latest === null) throw new Error('hook has not rendered');
            return latest;
        },
        get external() {
            return external;
        },
        resize(size: Size) {
            el.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height);
            act(() => {
                for (const callback of resizeCallbacks) callback();
            });
        },
        unmount: () => act(() => root.unmount()),
    };
}

describe('useElementSize', () => {
    test('reports the measured box and keeps the last real one across a 0x0 reading', () => {
        const h = mount();
        expect(h.size).toEqual({ width: 0, height: 0 });

        h.resize({ width: 800, height: 600 });
        expect(h.size).toEqual({ width: 800, height: 600 });

        // A hidden pane measures zero; flipping layout to zero and back would be a visible jump.
        h.resize({ width: 0, height: 0 });
        expect(h.size).toEqual({ width: 800, height: 600 });

        h.resize({ width: 420, height: 600 });
        expect(h.size).toEqual({ width: 420, height: 600 });
        h.unmount();
    });

    test('fills the external ref, so the caller keeps a handle on the node', () => {
        const h = mount();
        h.resize({ width: 100, height: 50 });
        expect(h.external).toBe(h.el);
        h.unmount();
    });
});
