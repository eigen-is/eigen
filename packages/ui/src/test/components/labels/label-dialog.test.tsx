// Add label and Edit label: a missing name is named and keeps the dialog open, Save hands the name and color on and
// closes, and a save that fails stays open. Delete asks first, on top of the open dialog, so a cancelled delete keeps
// the edits. The label header's pencil edits its label, and a failed save there stays open too.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants';
import type { Label } from '@workspace/lib/types/label';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const updateLabel = mock(async (_label: Label) => {});
const deleteLabel = mock(async (_id: string) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useUpdateLabel: () => ({ mutateAsync: updateLabel }),
    useDeleteLabel: () => ({ mutateAsync: deleteLabel }),
}));
afterAll(() => {
    mock.module('@workspace/lib/contacts', () => realContacts);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { LabelDialog } = await import('../../../components/labels/label-dialog');
const { LabelFilterHeader } = await import('../../../components/labels/label-filter-header');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};

const urgent: Label = { id: 'l1', name: 'Urgent', color: '#ef4444' };
const onSubmit = mock(async (_data: { name: string; color: string }) => {});
const onDelete = mock(async () => {});
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    for (const fn of [onSubmit, onDelete, updateLabel, deleteLabel]) {
        fn.mockReset();
        fn.mockImplementation(async () => {});
    }
    onOpenChange.mockClear();
});

// The dialog under a parent that owns `open`, as the label list does.
function Harness({ selectedLabel }: { selectedLabel: Label | null }) {
    const [open, setOpen] = useState(true);
    return createElement(LabelDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        selectedLabel,
        onSubmit,
        onDelete,
        labelCount: 2,
    });
}

async function open(selectedLabel: Label | null) {
    ({ unmount } = await renderInDocument(createElement(Harness, { selectedLabel })));
}

const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const dialogTitled = (title: string) => dialogs().find((d) => d.querySelector('h2')?.textContent === title);
const button = (dialog: Element | undefined, label: string) =>
    [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const nameField = () => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Enter label name"]');
    if (!input) throw new Error('the dialog has no name field');
    return input;
};
const type = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const click = (target: HTMLButtonElement | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('Add label names a missing name and stays open, then hands the label on and closes', async () => {
    await open(null);
    const dialog = dialogTitled('Add label');
    expect(dialog?.textContent).toContain('Add a new label to your collection.');
    expect(button(dialog, 'Delete')).toBeUndefined();

    await click(button(dialog, 'Save'));
    await settle();
    expect(dialog?.textContent).toContain('Label name is required.');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await type('Family');
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(onSubmit.mock.calls).toEqual([[{ name: 'Family', color: EIGEN_ACCENT_COLORS_SHUFFLED[2].value }]]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a save that fails keeps the dialog open', async () => {
    onSubmit.mockImplementation(async () => {
        throw toasted('offline');
    });
    await open(urgent);
    await click(button(dialogTitled('Edit label'), 'Save'));
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Delete asks on top of the open dialog, a cancel keeps the edits, and a yes deletes', async () => {
    await open(urgent);
    expect(dialogTitled('Edit label')?.textContent).toContain('Make changes to your label here.');
    expect(nameField().value).toBe('Urgent');
    await type('Later');
    await click(button(dialogTitled('Edit label'), 'Delete'));
    expect(dialogTitled('Delete label')).toBeDefined();
    expect(dialogTitled('Edit label')).toBeDefined();

    await click(button(dialogTitled('Delete label'), 'Cancel'));
    expect(nameField().value).toBe('Later');

    await click(button(dialogTitled('Edit label'), 'Delete'));
    await click(button(dialogTitled('Delete label'), 'Delete'));
    await settle();
    expect(onDelete).toHaveBeenCalledTimes(1);
});

test("the label header's pencil saves its label, and a failed save stays open", async () => {
    updateLabel.mockImplementationOnce(async () => {
        throw toasted('offline');
    });
    ({ unmount } = await renderInDocument(createElement(LabelFilterHeader, { labels: [urgent], labelId: 'l1' })));
    await click(document.querySelector<HTMLButtonElement>('button') ?? undefined);
    await type('Later');
    await click(button(dialogTitled('Edit label'), 'Save'));
    await settle();
    expect(updateLabel.mock.calls).toEqual([[{ id: 'l1', name: 'Later', color: '#ef4444' }]]);
    expect(dialogTitled('Edit label')).toBeDefined();

    await click(button(dialogTitled('Edit label'), 'Save'));
    await settle();
    expect(updateLabel).toHaveBeenCalledTimes(2);
    expect(dialogTitled('Edit label')).toBeUndefined();
});
