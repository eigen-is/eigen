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

const OWN = ['window', 'document', 'navigator', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'];

export function installHappyDom(): Window {
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

    afterAll(() => {
        for (const key of borrowed) g[key] = undefined;
        for (const key of OWN) g[key] = undefined;
    });

    return window;
}
