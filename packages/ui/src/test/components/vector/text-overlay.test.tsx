import { expect, test } from 'bun:test';
import { labelText } from '@workspace/lib/vector';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

// Each face loads only the unicode-range slices its text needs, so the overlay hands the font set its text. The log
// keeps the order of loads and commits.
const events: string[] = [];
Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
        load: async (_font: string, text?: string) => {
            events.push(`load ${JSON.stringify(text)}`);
            return [];
        },
    },
});

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TextOverlay } = await import('../../../components/vector/text-overlay');

// Types `typed` into a label session opened on `initialText` and returns what the single commit carried.
async function commitTyped(typed: string, initialText = ''): Promise<string> {
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
                initialText,
                fontSize: 20,
                fontFamily: 'Excalifont',
                color: '#000000',
                onCommit: (text: string) => {
                    events.push(`commit ${text}`);
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
// character, so a UTF-16 maxLength is the wrong unit) and lines. Anything past either cap every peer's
// read would drop.
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

// The host measures the label at commit, so the slices of the typed text are asked for before then. A fresh label
// has no text yet and loads the slice with the space.
test('the overlay loads the slices of its text before the commit', async () => {
    events.length = 0;
    await commitTyped('茶 tea');
    expect(events).toEqual(['load " "', 'load "茶 tea"', 'commit 茶 tea']);
});

test('an overlay opened on a label loads the slices of that label', async () => {
    events.length = 0;
    await commitTyped('😀 ok', '茶');
    expect(events).toEqual(['load "茶"', 'load "😀 ok"', 'commit 😀 ok']);
});
