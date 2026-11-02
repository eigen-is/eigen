// The recurring action dialog asks which events of a series an edit or delete applies to. It starts at the first
// option on every opening, and a screen reader names its choices by the dialog's title. OK hands the chosen one on
// and closes, and a confirm that fails keeps it open.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { RecurringAction } from '../../components/recurring-action-dialog';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};
const { RecurringActionDialog } = await import('../../components/recurring-action-dialog');

const onConfirm = mock(async (_action: RecurringAction) => {});
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    onConfirm.mockReset();
    onConfirm.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

// The dialog under a parent that owns `open`, as the event dialogs do, so a test can close and reopen it.
let setOpen = (_open: boolean) => {};
function Harness({ options }: { options?: RecurringAction[] }) {
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    return createElement(RecurringActionDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpenState(next);
        },
        title: 'Delete recurring event',
        onConfirm,
        options,
    });
}

async function open(options?: RecurringAction[]) {
    ({ unmount } = await renderInDocument(createElement(Harness, { options })));
}

const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="radio"]')];
const checked = () => radios().find((radio) => radio.getAttribute('aria-checked') === 'true')?.id;
const labels = () => [...document.querySelectorAll('[role="dialog"] label')].map((label) => label.textContent);
const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label);

test('it offers the options it is given, the first one chosen', async () => {
    await open(['this', 'all']);
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Delete recurring event');
    expect(labels()).toEqual(['This event', 'All events in series']);
    expect(checked()).toBe('recurring-this');
    expect(document.querySelector('[role="dialog"] [role="radiogroup"]')?.getAttribute('aria-label')).toBe(
        'Delete recurring event',
    );
});

test('OK hands the chosen option on, and the dialog closes', async () => {
    await open();
    expect(labels()).toEqual(['This event', 'This and following events', 'All events in series']);
    await act(async () => radios()[2]?.click());
    await act(async () => button('OK')?.click());
    expect(onConfirm.mock.calls).toEqual([['all']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Cancel closes without confirming', async () => {
    await open();
    await act(async () => button('Cancel')?.click());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a confirm that fails keeps the dialog open', async () => {
    onConfirm.mockImplementation(async () => {
        throw toasted('offline');
    });
    await open();
    await act(async () => button('OK')?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('OK')?.disabled).toBe(false);
});

test('reopening starts at the first option again', async () => {
    await open();
    await act(async () => radios()[2]?.click());
    expect(checked()).toBe('recurring-all');
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(checked()).toBe('recurring-this');
});
