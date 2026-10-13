// Page setup is Google Slides' slide size, 16:9 or 4:3. A writer changes the deck's size with OK; a viewer reads it.
import { afterEach, expect, mock, test } from 'bun:test';
import type { SlideSize } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { PageSetupDialog } = await import('../../../components/slides/page-setup-dialog');

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const radios = () =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].map((radio) => ({
        label: document.querySelector(`label[for="${radio.id}"]`)?.textContent,
        checked: radio.getAttribute('aria-checked') === 'true',
        disabled: radio.disabled,
    }));
const radio = (label: string) =>
    [...document.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor ?? '';

const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

let unmount = async () => {};
afterEach(() => unmount());

const onOpenChange = mock((_open: boolean) => {});
const onSlideSizeChange = mock((_size: SlideSize) => {});

let setStored = (_size: SlideSize) => {};

// The deck's stored size as live state, so a test can change it the way a peer's write reaches the open dialog.
function Deck({ initial, canWrite }: { initial: SlideSize; canWrite: boolean }) {
    const [slideSize, setSlideSize] = useState(initial);
    setStored = setSlideSize;
    return createElement(PageSetupDialog, { open: true, onOpenChange, slideSize, canWrite, onSlideSizeChange });
}

async function render(slideSize: SlideSize = '16:9', canWrite = true) {
    onOpenChange.mockClear();
    onSlideSizeChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(Deck, { initial: slideSize, canWrite })));
}

const peerSets = (size: SlideSize) => act(async () => setStored(size));

test("a writer sees the deck's size among Google's two, both enabled", async () => {
    await render();
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Page setup');
    expect(radios()).toEqual([
        { label: 'Widescreen 16:9', checked: true, disabled: false },
        { label: 'Standard 4:3', checked: false, disabled: false },
    ]);
    expect(button('Close')).toBeUndefined();
});

test('OK writes the picked size once and closes', async () => {
    await render();
    await click(document.getElementById(radio('Standard 4:3')));
    await click(button('OK'));
    expect(onSlideSizeChange.mock.calls).toEqual([['4:3']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('OK on the size the deck already has writes nothing', async () => {
    await render('4:3');
    await click(button('OK'));
    expect(onSlideSizeChange).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Cancel closes without a change', async () => {
    await render();
    await click(document.getElementById(radio('Standard 4:3')));
    await click(button('Cancel'));
    expect(onSlideSizeChange).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test("a peer's change shows in the open dialog, and OK then keeps it", async () => {
    await render();
    await peerSets('4:3');
    expect(radios().map(({ checked }) => checked)).toEqual([false, true]);
    await click(button('OK'));
    expect(onSlideSizeChange).not.toHaveBeenCalled();
});

test("a pick outlives a peer's change, and OK writes it", async () => {
    await render();
    await click(document.getElementById(radio('Standard 4:3')));
    await peerSets('16:9');
    expect(radios().map(({ checked }) => checked)).toEqual([false, true]);
    await click(button('OK'));
    expect(onSlideSizeChange.mock.calls).toEqual([['4:3']]);
});

test('a viewer sees the size read-only, with one Close button', async () => {
    await render('4:3', false);
    expect(radios()).toEqual([
        { label: 'Widescreen 16:9', checked: false, disabled: true },
        { label: 'Standard 4:3', checked: true, disabled: true },
    ]);
    expect(button('OK')).toBeUndefined();
    expect(button('Cancel')).toBeUndefined();
    await click(button('Close'));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(onSlideSizeChange).not.toHaveBeenCalled();
});
