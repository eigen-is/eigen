// The browser a component test renders into: one happy-dom window borrowed onto globalThis, put back
// again in afterAll so later test files in the same bun process see the plain environment.
//
// Call this BEFORE the `await import(...)` lines that pull in React and the component under test.
// Those modules read `document`, `window` and the event constructors while they evaluate, so they may
// not be imported until the globals are in place — which is also why they are dynamic imports at all:
// a static `import` hoists above this call.

import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// Taken from the window even where bun already has one: happy-dom rejects a foreign Event instance,
// and Radix dispatches its own CustomEvents.
const OVERRIDDEN = [
    'DOMParser',
    'DOMRect',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'WheelEvent',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLFormElement',
];

const OWN = [
    'window',
    'document',
    'navigator',
    'getComputedStyle',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
];

export type HappyDomOptions = {
    /**
     * Receives a trigger for every ResizeObserver the code under test constructs, so a test can
     * drive a re-measure itself — happy-dom lays nothing out, so nothing else ever fires one. Each
     * observed target reports its stubbed `getBoundingClientRect()` as the entry's `contentRect`.
     */
    onResizeObserver?: (callback: () => void) => void;
};

/** Installs the window and registers its own cleanup. Returns it, for the rare test that needs a
 * constructor off the window itself (a prototype descriptor, say). */
export function installHappyDom(options: HappyDomOptions = {}): Window {
    const window = new Window({ url: 'http://localhost:3000' });
    const borrowed: string[] = [];
    for (const key of Object.getOwnPropertyNames(window)) {
        // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
        const value = (window as any)[key];
        if (g[key] === undefined && value !== undefined) {
            g[key] = value;
            borrowed.push(key);
        }
    }
    for (const key of OVERRIDDEN) {
        // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
        g[key] = (window as any)[key];
        borrowed.push(key);
    }
    g.window = window;
    g.document = window.document;
    g.navigator = window.navigator;
    g.getComputedStyle = window.getComputedStyle.bind(window);
    g.IS_REACT_ACT_ENVIRONMENT = true;

    const { onResizeObserver } = options;
    class FakeResizeObserver {
        private targets: Element[] = [];
        constructor(callback: (entries: { target: Element; contentRect: DOMRect }[]) => void) {
            onResizeObserver?.(() =>
                callback(this.targets.map((target) => ({ target, contentRect: target.getBoundingClientRect() }))),
            );
        }
        observe(target: Element) {
            this.targets.push(target);
        }
        unobserve(target: Element) {
            this.targets = this.targets.filter((t) => t !== target);
        }
        disconnect() {
            this.targets = [];
        }
    }
    g.ResizeObserver = FakeResizeObserver;
    // Radix and the canvas hooks paint inside one rAF; running it inline keeps every assertion on the
    // settled result.
    g.requestAnimationFrame = (callback: () => void) => {
        callback();
        return 0;
    };
    g.cancelAnimationFrame = () => {};

    afterAll(async () => {
        // floating-ui positions asynchronously; let its pending work finish while the DOM is still there.
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const key of borrowed) g[key] = undefined;
        for (const key of OWN) g[key] = undefined;
    });

    return window;
}
