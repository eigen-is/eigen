// Edit calendar keeps the dialog contract, opening on its name rather than the color beside it. New calendar says
// Create and Edit calendar Save, a name of only spaces says "Add a name" under the field, and the button creates or
// updates the calendar with the name trimmed and closes. A person typed but not added is shared with on Save, and
// your own address is refused with the reason. A save the server refuses stays open with no unhandled rejection.
// Delete asks first, on top of the open dialog, so a cancelled delete keeps the user's edits. The default calendar has
// no Delete. Share with team sits in the footer after the trash, as in the Share dialog.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { expectFormContract, type } from '@workspace/ui/test/form-contract';
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
let myTeams: { id: string; name: string }[] = [];
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: myTeams }) }));
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
    myTeams = [];
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
    [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => (b.textContent || b.getAttribute('aria-label')) === label,
    );
const nameField = () => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Enter calendar name"]');
    if (!input) throw new Error('the dialog has no name field');
    return input;
};
const click = (target: HTMLButtonElement | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('Edit calendar keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Harness, { item: calendar({}) }),
        submitLabel: 'Save',
        firstField: 'Calendar name',
        onSubmit: updateCalendar.mutateAsync,
        makeChanged: () => type(nameField(), 'Office'),
        makeInvalid: () => type(nameField(), '  '),
        invalidField: 'Calendar name',
    });
});

test('New calendar says Create, refuses a name of only spaces under the field, then creates it trimmed', async () => {
    await open(null);
    const dialog = dialogTitled('New calendar');
    expect(dialog?.querySelector('[data-slot="dialog-description"]')).toBeNull();
    expect(button(dialog, 'Delete calendar')).toBeUndefined();
    expect(document.activeElement).toBe(nameField());

    await type(nameField(), '   ');
    await act(async () => pressEnter(nameField()));
    await settle();
    expect(dialog?.querySelector('[data-slot="field-error"]')?.textContent).toBe('Add a name');
    expect(createCalendar.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await type(nameField(), ' Gym ');
    await click(button(dialog, 'Create'));
    await settle();
    expect(createCalendar.mutateAsync.mock.calls).toEqual([
        [{ name: 'Gym', color: EIGEN_ACCENT_COLORS_SHUFFLED[3].value }],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

const shareField = () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] #share-contact');
    if (!input) throw new Error('the dialog has no share field');
    return input;
};

test('a person typed but not added is shared with on Save', async () => {
    await open(calendar({}));
    await type(shareField(), 'bea@example.org');
    await click(button(dialogTitled('Edit calendar'), 'Save'));
    await settle();
    expect(updateCalendar.mutateAsync.mock.calls.at(-1)?.[0]).toMatchObject({
        shares: [
            { targetId: 'ada@example.org', permission: 'read' },
            { targetId: 'bea@example.org', permission: 'read' },
        ],
    });
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('your own address is refused under the share field, and Save stays open with it', async () => {
    await open(calendar({}));
    await type(shareField(), 'Me@test.eigen.is');
    await act(async () => pressEnter(shareField()));
    const message = () => dialogTitled('Edit calendar')?.querySelector('[data-slot="field-error"]')?.textContent;
    expect(message()).toBe('You cannot share a calendar with yourself');
    await click(button(dialogTitled('Edit calendar'), 'Save'));
    await settle();
    expect(updateCalendar.mutateAsync).not.toHaveBeenCalled();
    expect(message()).toBe('You cannot share a calendar with yourself');
    expect(document.activeElement).toBe(shareField());
});

test('Edit calendar starts from the calendar and saves its name, color and shares', async () => {
    await open(calendar({}));
    const dialog = dialogTitled('Edit calendar');
    expect(dialog?.querySelector('[data-slot="dialog-description"]')).toBeNull();
    expect(nameField().value).toBe('Work');
    await type(nameField(), 'Office');
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
    await type(nameField(), 'Office');
    expect(button(dialogTitled('Edit calendar'), 'Delete calendar')?.dataset.variant).toBe('ghost');
    await click(button(dialogTitled('Edit calendar'), 'Delete calendar'));
    expect(dialogTitled('Delete calendar')?.querySelector('p')?.innerHTML).toBe(
        'Are you sure you want to delete <strong>Work</strong>? All events in it will be lost.',
    );
    expect(button(dialogTitled('Delete calendar'), 'Delete')?.getAttribute('data-variant')).toBe('destructive');
    expect(dialogTitled('Edit calendar')).toBeDefined();

    await click(button(dialogTitled('Delete calendar'), 'Cancel'));
    expect(dialogTitled('Delete calendar')).toBeUndefined();
    expect(nameField().value).toBe('Office');

    await click(button(dialogTitled('Edit calendar'), 'Delete calendar'));
    await click(button(dialogTitled('Delete calendar'), 'Delete'));
    await settle();
    expect(deleteCalendar.mutateAsync.mock.calls).toEqual([['work']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(dialogs()).toEqual([]);
});

test('the default calendar has no Delete', async () => {
    await open(calendar({ isDefault: true }));
    expect(button(dialogTitled('Edit calendar'), 'Delete calendar')).toBeUndefined();
});

test('Share with team sits in the footer after the trash, as in the Share dialog', async () => {
    myTeams = [{ id: 'crew', name: 'Crew' }];
    await open(calendar({}));
    const footer = dialogTitled('Edit calendar')?.querySelector('[data-slot="dialog-footer"]');
    expect(
        [...(footer?.querySelectorAll('button') ?? [])].map((b) => b.textContent || b.getAttribute('aria-label')),
    ).toEqual(['Delete calendar', 'Share with team', 'Cancel', 'Save']);
});

test("a phone's footer shows only the icon of Share with team, and a screen reader still reads its name", async () => {
    myTeams = [{ id: 'crew', name: 'Crew' }];
    await open(calendar({}));
    const label = [
        ...(dialogTitled('Edit calendar')?.querySelectorAll('[data-slot="dialog-footer"] button span') ?? []),
    ].find((span) => span.textContent === 'Share with team');
    expect(label?.classList.contains('max-sm:sr-only')).toBe(true);
});

test('the color swatch sits inside the name field, which its label names', async () => {
    await open(calendar({}));
    expect(
        nameField().closest('[data-slot="input-group"]')?.querySelector('button[aria-label="Color"]'),
    ).not.toBeNull();
    expect(document.querySelector<HTMLLabelElement>(`label[for="${nameField().id}"]`)?.textContent).toBe(
        'Calendar name',
    );
});
