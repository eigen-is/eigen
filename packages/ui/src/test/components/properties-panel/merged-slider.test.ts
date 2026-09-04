import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as Y from 'yjs';

// react-dom needs a DOM to render into, and Radix's Slider needs a ResizeObserver and an rAF. The
// globals are removed again in afterAll so later test files see the plain bun environment. Recipe:
// the use-viewport test next door.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.DOMRect = window.DOMRect;
g.KeyboardEvent = window.KeyboardEvent;
g.Element = window.Element;
g.HTMLElement = window.HTMLElement;
g.IS_REACT_ACT_ENVIRONMENT = true;
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}
g.ResizeObserver = FakeResizeObserver;
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
    g.KeyboardEvent = undefined;
    g.Element = undefined;
    g.HTMLElement = undefined;
    g.ResizeObserver = undefined;
    g.requestAnimationFrame = undefined;
    g.cancelAnimationFrame = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { holdCapture } = await import('../../../components/vector/hooks/use-canvas-doc');
const { MergedSlider } = await import('../../../components/properties-panel/merged-slider');

// Escape mid-drag deselects and unmounts the panel section, and so does a peer deleting the element.
// The hold must not outlive the component: an unreleased one leaves captureTimeout at Infinity, and
// every later edit in the session then merges into one undo step.
test('a gesture cut short by unmount still releases the capture hold', () => {
    const doc = new Y.Doc();
    const undoManager = new Y.UndoManager(doc.getMap('elements'));
    const original = undoManager.captureTimeout;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
        root.render(
            createElement(MergedSlider, {
                value: 50,
                onChange: () => {},
                beginGesture: () => holdCapture(undoManager),
                min: 0,
                max: 100,
                'aria-label': 'Opacity',
            }),
        ),
    );

    // An arrow key on the thumb is Radix's own continuous edit — it opens the gesture without a commit.
    const thumb = container.querySelector('[role="slider"]');
    if (!thumb) throw new Error('slider did not render its thumb');
    act(() => {
        thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(undoManager.captureTimeout).toBe(Number.POSITIVE_INFINITY);

    act(() => root.unmount());
    expect(undoManager.captureTimeout).toBe(original);
});
