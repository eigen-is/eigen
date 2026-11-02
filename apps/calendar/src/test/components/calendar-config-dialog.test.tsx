// New calendar and Edit calendar: a name the schema refuses is named and keeps the dialog open, Save creates or
// updates the calendar and closes, and a save the server refuses stays open with no unhandled rejection. Delete asks
// first, on top of the open dialog, so a cancelled delete keeps the user's edits. The default calendar has no Delete.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const created = new Date('2026-10-01T00:00:00Z');
const calendar = (p: Partial<CalendarItem>): CalendarItem => ({
    id: 'work',
    name: 'Work',
    color: '#3b82f6',
    isDefault: false,
    visible: true,
    ctag: 1,
    shares: [{ targetId: 'ada@example.org', permission: 'read' }],
    createdAt: created,
    updatedAt: created,
    ...p,
});
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const createCalendar = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
const updateCalendar = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
const deleteCalendar = { mutateAsync: mock(async (_id: string) => {}), isPending: false };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
const realHome = { ...(await import('@workspace/lib/home')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useCreateCalendar: () => createCalendar,
    useUpdateCalendar: () => updateCalendar,
    useDeleteCalendar: () => deleteCalendar,
}));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: [] }) }));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
// A share row names the person by address, without looking up who it is.
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email }: { email?: string }) => ({
        displayName: email ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/calendar', () => realCalendar);
    mock.module('@workspace/lib/home', () => realHome);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/public', () => realPublic);
});

// A rejected save the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};
const { CalendarConfigDialog } = await import('../../components/calendar-config-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    for (const mutation of [createCalendar, updateCalendar, deleteCalendar]) {
        mutation.mutateAsync.mockReset();
        mutation.mutateAsync.mockImplementation(async () => {});
    }
    onOpenChange.mockClear();
    unhandled.length = 0;
});

// The dialog under a parent that owns `open`, as the sidebar does.
function Harness({ item }: { item: CalendarItem | null }) {
    const [open, setOpen] = useState(true);
    return createElement(CalendarConfigDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        calendar: item,
        calendarCount: 3,
    });
}

async function open(item: CalendarItem | null) {
    ({ unmount } = await renderInDocument(createElement(Harness, { item })));
}

const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const dialogTitled = (title: string) => dialogs().find((d) => d.querySelector('h2')?.textContent === title);
const button = (dialog: Element | undefined, label: string) =>
    [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const nameField = () => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Enter calendar name"]');
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

test('New calendar names a missing name and stays open, then creates the calendar and closes', async () => {
    await open(null);
    const dialog = dialogTitled('New calendar');
    expect(dialog?.textContent).toContain('Create a new calendar.');
    expect(button(dialog, 'Delete')).toBeUndefined();

    await click(button(dialog, 'Save'));
    await settle();
    expect(dialog?.textContent).toContain('Calendar name is required.');
    expect(createCalendar.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await type('Gym');
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(createCalendar.mutateAsync.mock.calls).toEqual([
        [{ name: 'Gym', color: EIGEN_ACCENT_COLORS_SHUFFLED[3].value }],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Edit calendar starts from the calendar and saves its name, color and shares', async () => {
    await open(calendar({}));
    const dialog = dialogTitled('Edit calendar');
    expect(dialog?.textContent).toContain('Edit calendar settings and sharing.');
    expect(nameField().value).toBe('Work');
    await type('Office');
    await click(button(dialog, 'Save'));
    await settle();
    expect(updateCalendar.mutateAsync.mock.calls).toEqual([
        [
            {
                id: 'work',
                name: 'Office',
                color: '#3b82f6',
                shares: [{ targetId: 'ada@example.org', permission: 'read' }],
            },
        ],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a save the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    updateCalendar.mutateAsync.mockImplementation(async () => {
        throw toasted('offline');
    });
    await open(calendar({}));
    await click(button(dialogTitled('Edit calendar'), 'Save'));
    await settle();
    expect(updateCalendar.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button(dialogTitled('Edit calendar'), 'Save')?.disabled).toBe(false);
    expect(unhandled).toEqual([]);
});

test('Delete asks on top of the open dialog, a cancel keeps the edits, and a yes deletes and closes', async () => {
    await open(calendar({}));
    await type('Office');
    await click(button(dialogTitled('Edit calendar'), 'Delete'));
    expect(dialogTitled('Delete calendar')).toBeDefined();
    expect(dialogTitled('Edit calendar')).toBeDefined();

    await click(button(dialogTitled('Delete calendar'), 'Cancel'));
    expect(dialogTitled('Delete calendar')).toBeUndefined();
    expect(nameField().value).toBe('Office');

    await click(button(dialogTitled('Edit calendar'), 'Delete'));
    await click(button(dialogTitled('Delete calendar'), 'Delete'));
    await settle();
    expect(deleteCalendar.mutateAsync.mock.calls).toEqual([['work']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(dialogs()).toEqual([]);
});

test('the default calendar has no Delete', async () => {
    await open(calendar({ isDefault: true }));
    expect(button(dialogTitled('Edit calendar'), 'Delete')).toBeUndefined();
});
