import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// react-dom needs a DOM to render into, and the popover is a real Radix layer (portal + focus scope +
// floating-ui), so this file borrows the whole happy-dom window rather than the handful of globals the
// merged-slider test next door needs. Everything borrowed is put back in afterAll so later test files
// see the plain bun environment. The event constructors are overridden even where bun already has one:
// happy-dom rejects a foreign Event instance, and Radix dispatches its own CustomEvents.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const borrowed: string[] = [];
for (const key of Object.getOwnPropertyNames(window)) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    const value = (window as any)[key];
    if (g[key] === undefined && value !== undefined) {
        g[key] = value;
        borrowed.push(key);
    }
}
for (const key of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element', 'HTMLElement']) {
    // biome-ignore lint/suspicious/noExplicitAny: reading the happy-dom window's own globals
    g[key] = (window as any)[key];
    borrowed.push(key);
}
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.getComputedStyle = window.getComputedStyle.bind(window);
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

afterAll(async () => {
    // floating-ui positions asynchronously; let its pending work finish while the DOM is still there.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.getComputedStyle = undefined;
    g.ResizeObserver = undefined;
    g.requestAnimationFrame = undefined;
    g.cancelAnimationFrame = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ColorRow } = await import('../../../components/properties-panel/color-row');

// Mounts a row, clicks its trigger, and reads back every label the open popover shows.
async function openPopover(props: { value: string; allowNone?: boolean; noneLabel?: string }) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(ColorRow, { label: 'Color', onChange: () => {}, ...props }));
    });

    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('color row did not render its trigger');
    await act(async () => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const labels = [...document.querySelectorAll('span')].map((el) => el.textContent?.trim() ?? '');
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { labels, cleanup };
}

// A picked colour is replaced by picking another one, and where paint is optional None is the way back
// — so a Reset row was a third way to say what the popover already says. It is gone from every row.
test('the popover never offers a Reset row', async () => {
    const withNone = await openPopover({ value: '#ff0000', allowNone: true });
    expect(withNone.labels).not.toContain('Reset');
    await withNone.cleanup();

    const withoutNone = await openPopover({ value: '#ff0000' });
    expect(withoutNone.labels).not.toContain('Reset');
    await withoutNone.cleanup();
});

// None stays opt-in: an arrow IS its stroke, so its colour row must not offer a way to erase it.
test('the None row shows only where the caller allows it', async () => {
    const optional = await openPopover({ value: '#ff0000', allowNone: true });
    expect(optional.labels).toContain('None');
    await optional.cleanup();

    const required = await openPopover({ value: '#ff0000' });
    expect(required.labels).not.toContain('None');
    await required.cleanup();
});

// The label is the caller's word for "no paint" — a gradient stop calls it Transparent.
test('allowNone renders the caller label', async () => {
    const { labels, cleanup } = await openPopover({
        value: '#ff0000',
        allowNone: true,
        noneLabel: 'Transparent',
    });
    expect(labels).toContain('Transparent');
    await cleanup();
});
