// The DOM a hook renders into and a parser test reads through: one happy-dom window borrowed onto
// globalThis, put back again in afterAll so later test files in the same bun process see the
// environment they started with.
//
// Call this BEFORE the `await import(...)` lines that pull in React and the hook under test. Those
// modules read `document` and `window` while they evaluate, so they may not be imported until the
// globals are in place — which is also why they are dynamic imports at all: a static `import` hoists
// above this call.

import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

/** Installs the window and registers its own cleanup. Returns it, for a test that needs the window
 * itself rather than the borrowed globals. */
export function installHappyDom(): Window {
    const window = new Window({ url: 'http://localhost:3000' });
    // Every borrowed global is remembered as it was and PUT BACK in afterAll, never cleared: bun has a
    // navigator of its own, and anything running after this teardown would find `undefined` where its
    // native value used to be.
    const previous = new Map<string, unknown>();
    const borrow = (key: string, value: unknown) => {
        previous.set(key, g[key]);
        g[key] = value;
    };

    borrow('window', window);
    borrow('document', window.document);
    borrow('navigator', window.navigator);
    // The html sanitizer parses with DOMParser and walks the result against Node's nodeType constants;
    // both have to come from this window, because a happy-dom node is an instance of nothing else.
    borrow('DOMParser', window.DOMParser);
    borrow('Node', window.Node);
    borrow('IS_REACT_ACT_ENVIRONMENT', true);

    afterAll(() => {
        for (const [key, value] of previous) g[key] = value;
    });

    return window;
}
