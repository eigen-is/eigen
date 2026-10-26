import { afterEach, expect, test } from 'bun:test';
import { slidePtToPx } from '@workspace/lib/vector';
import { installHappyDom } from '../../happy-dom';

const window = installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FontSizeRow } = await import('../../../components/properties-panel/font-size-row');

const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

// What a pptx's 44 pt title stores on a 10 in deck.
const TITLE = 117.33333333333334;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
});

// Renders the row over `sizes` and answers its input and the stored sizes each write would leave.
async function render(sizes: number[], slideWidth: number | undefined) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const writes: number[][] = [];
    await act(async () => {
        root.render(
            createElement(FontSizeRow, {
                sizes,
                slideWidth,
                onChange: (size: (px: number) => number) => writes.push(sizes.map(size)),
            }),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const input = container.querySelector('input');
    if (!input) throw new Error('the row rendered no input');
    // The stepper's − and + flank its box.
    const increase = container.querySelectorAll('button')[1];
    return { input, writes, increase };
}

async function visit(input: HTMLInputElement, typed?: string) {
    await act(async () => {
        input.focus();
    });
    if (typed !== undefined) {
        await act(async () => {
            nativeValueSetter?.call(input, typed);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    await act(async () => {
        input.blur();
    });
}

test('a deck shows a stored px in pt on the half-point grid, and showing it writes nothing', async () => {
    const { input, writes } = await render([TITLE], 720);
    expect(input.value).toBe('44');
    await visit(input);
    expect(writes).toEqual([]);
});

test('a selection whose sizes show alike merges to one pt and writes nothing; unlike ones show none', async () => {
    const alike = await render([TITLE, 117.4], 720);
    expect(alike.input.value).toBe('44');
    await visit(alike.input);
    expect(alike.writes).toEqual([]);
    await cleanup?.();
    const unlike = await render([TITLE, 88], 720);
    expect(unlike.input.value).toBe('');
    expect(unlike.writes).toEqual([]);
});

test('a typed pt writes its px at the deck width', async () => {
    const { input, writes } = await render([TITLE], 720);
    await visit(input, '18');
    expect(writes).toEqual([[48]]);
});

test("a step moves each box from its own shown pt, as Docs' and Sheets' do", async () => {
    const { writes, increase } = await render([TITLE, 88], 960);
    await act(async () => increase.click());
    // 58.67 pt shows 58.5, 44 pt shows 44.
    expect(writes).toEqual([[slidePtToPx(59.5, 960), slidePtToPx(45, 960)]]);
});

test('a drawing shows whole px, and showing a size writes nothing', async () => {
    const { input, writes } = await render([TITLE, 117.4], undefined);
    expect(input.value).toBe('117');
    await visit(input);
    expect(writes).toEqual([]);
});
