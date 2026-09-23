// The browser a component test renders into: one happy-dom window borrowed onto globalThis, put
// back again in afterAll so later test files in the same bun process see the plain environment.
// packages/ui keeps its own copy — a package's test helpers are not on its exports map, so neither
// side can import the other's.
//
// Call this BEFORE the `await import(...)` lines that pull in React and the component under test:
// those modules read `document`, `window` and the event constructors while they evaluate, which is
// also why they are dynamic imports at all — a static `import` hoists above this call.

import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// Taken from the window even where bun already has one: happy-dom rejects a foreign Event instance.
const OVERRIDDEN = ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element', 'HTMLElement'];

export function installHappyDom(): Window {
    const window = new Window({ url: 'http://localhost:3000' });
    // Every borrowed global is remembered as it was and PUT BACK in afterAll, never cleared: bun has
    // an Event and a CustomEvent of its own, and anything running after this teardown would find
    // `undefined` where its native constructor used to be.
    const previous = new Map<string, unknown>();
    const borrow = (key: string, value: unknown) => {
        if (!previous.has(key)) previous.set(key, g[key]);
        g[key] = value;
    };

    for (const key of Object.getOwnPropertyNames(window)) {
        // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
        const value = (window as any)[key];
        if (g[key] === undefined && value !== undefined) borrow(key, value);
    }
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    for (const key of OVERRIDDEN) borrow(key, (window as any)[key]);
    borrow('window', window);
    borrow('document', window.document);
    borrow('navigator', window.navigator);
    borrow('getComputedStyle', window.getComputedStyle.bind(window));
    borrow('IS_REACT_ACT_ENVIRONMENT', true);

    afterAll(async () => {
        // react-dom reads `window.event` for any update still queued; let it run while the DOM is still there.
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const [key, value] of previous) g[key] = value;
    });

    return window;
}
