// With nothing selected, the side panel shows the slide's background. Its two buttons copy that background to the
// following slides or to every slide in one write, so one press is one undo step.
import { afterEach, expect, mock, test } from 'bun:test';
import type { VectorFrame } from '@workspace/lib/vector';
import { SLIDE_SIZES } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { SlideBackgroundPanel } = await import('../../../components/slides/slide-background-panel');

const deck: VectorFrame[] = ['a', 'b', 'c'].map((id, i) => ({
    id,
    index: `a${i}`,
    name: '',
    ...SLIDE_SIZES['16:9'],
    background: '',
}));
const red = { type: 'solid', color: '#ff0000' } as const;
const painted = JSON.stringify(red);

let unmount = async () => {};
afterEach(() => unmount());

async function renderPanel() {
    const updateFrames = mock((_patches: { id: string; fields: Partial<VectorFrame> }[]) => {});
    let container: HTMLElement;
    ({ container, unmount } = await renderInDocument(
        createElement(SlideBackgroundPanel, {
            frames: deck,
            frameId: 'b',
            background: red,
            backgroundImageUrl: null,
            updateFrames,
            onUploadImage: async () => null,
            onPickImageFromDrive: () => {},
        }),
    ));
    const press = (label: string) =>
        act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === label)?.click());
    return { container, updateFrames, press };
}

test('Apply to following slides copies the background from this slide on, in one write', async () => {
    const { updateFrames, press } = await renderPanel();
    await press('Apply to following slides');
    expect(updateFrames.mock.calls).toEqual([
        [
            [
                { id: 'b', fields: { background: painted } },
                { id: 'c', fields: { background: painted } },
            ],
        ],
    ]);
});

test('Apply to all slides copies the background to every slide, in one write', async () => {
    const { updateFrames, press } = await renderPanel();
    await press('Apply to all slides');
    expect(updateFrames.mock.calls).toEqual([[deck.map(({ id }) => ({ id, fields: { background: painted } }))]]);
});

test('the panel has no Apply to select', async () => {
    const { container } = await renderPanel();
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(container.textContent).not.toContain('This and following');
});
