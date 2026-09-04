import { afterAll, expect, test } from 'bun:test';
import { labelText } from '@workspace/lib/vector';
import { Window } from 'happy-dom';

// The overlay commits through React state, so this file borrows a whole happy-dom window the way the
// color-row test next door does, and puts every global back afterwards.
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
g.IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
    for (const key of borrowed) g[key] = undefined;
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TextOverlay } = await import('../../../components/vector/text-overlay');

// Types `typed` into a freshly opened label session and returns what the single commit carried.
async function commitTyped(typed: string): Promise<string> {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let committed: string | null = null;
    await act(async () => {
        root.render(
            createElement(TextOverlay, {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                angle: 0,
                zoom: 1,
                containerRef: createRef<HTMLElement>(),
                boxToStyle: () => ({}),
                initialText: '',
                fontSize: 20,
                fontFamily: 'Excalifont',
                textAlign: 'center' as const,
                color: '#000000',
                onCommit: (text: string) => {
                    committed = text;
                },
            }),
        );
    });

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('the overlay did not render its textarea');
    await act(async () => {
        textarea.value = typed;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    await act(async () => root.unmount());
    container.remove();

    if (committed === null) throw new Error('the overlay never committed');
    return committed;
}

// The overlay must commit what the reader keeps: labelText caps BYTES (a CJK label is three bytes a
// character, so a UTF-16 maxLength is the wrong unit) and lines. Anything past either cap used to be
// stored and then silently dropped by every peer's read.
test('a label past the byte cap commits truncated to what the reader keeps', async () => {
    const typed = '茶'.repeat(4096);
    const committed = await commitTyped(typed);
    expect(committed).not.toBe(typed);
    expect(committed).toBe(labelText(typed));
    expect(new TextEncoder().encode(committed).length).toBeLessThanOrEqual(4 * 1024);
});

test('a label past the line cap commits truncated to what the reader keeps', async () => {
    const typed = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const committed = await commitTyped(typed);
    expect(committed).toBe(labelText(typed));
    expect(committed.split('\n').length).toBeLessThan(200);
});
