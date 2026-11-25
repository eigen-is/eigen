// A close with nothing changed discards at once. A changed one asks "Discard changes?": Keep editing goes back with
// nothing discarded, and the red Discard discards.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { useDiscardChanges } = await import('../../hooks/use-discard-changes');

let unmount = async () => {};
afterEach(() => unmount());

async function mount(changed: boolean) {
    const onDiscard = mock(() => {});
    let onOpenChange = (_open: boolean) => {};
    function Harness() {
        const discard = useDiscardChanges({ changed, onDiscard });
        onOpenChange = discard.onOpenChange;
        return discard.dialog;
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    return { onDiscard, requestClose: () => act(async () => onOpenChange(false)) };
}

const question = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(question()?.querySelectorAll('button') ?? [])].find((b) => b.lastChild?.textContent === label);
const click = (label: string) =>
    act(async () => {
        const target = button(label);
        if (!target) throw new Error(`no ${label} button`);
        target.click();
    });

test('with nothing changed a close discards at once, without asking', async () => {
    const { onDiscard, requestClose } = await mount(false);
    await requestClose();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(question()).toBeNull();
});

test('with a change a close asks, and Keep editing discards nothing', async () => {
    const { onDiscard, requestClose } = await mount(true);
    await requestClose();
    expect(question()?.querySelector('h2')?.textContent).toBe('Discard changes?');
    expect(question()?.textContent).toContain('What you changed is not saved.');
    expect(button('Discard')?.dataset.variant).toBe('destructive');
    await click('Keep editing');
    expect(onDiscard).not.toHaveBeenCalled();
    expect(question()).toBeNull();
});

test('with a change Discard discards and the question closes', async () => {
    const { onDiscard, requestClose } = await mount(true);
    await requestClose();
    await click('Discard');
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(question()).toBeNull();
});
