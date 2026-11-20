// Shared calendar settings names the calendar and the access the user has. Save keeps the user's own color, or none
// when it is the owner's, and closes, and a save the server refuses stays open with no unhandled rejection. Remove
// asks first, on top of the open dialog. A team's calendar can't be removed and lists no people.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { SharedCalendar } from '@workspace/lib/types/calendar';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const created = new Date('2026-10-01T00:00:00Z');
const shared = (p: Partial<SharedCalendar>): SharedCalendar => ({
    id: 'sc1',
    ownerUserId: 'u2',
    calendarId: 'team-cal',
    calendarName: 'Team',
    calendarColor: '#22c55e',
    permission: 'read',
    color: null,
    visible: true,
    createdAt: created,
    updatedAt: created,
    ...p,
});
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const updateShared = { mutateAsync: mock(async (_input: unknown) => {}), isPending: false };
const deleteShared = { mutateAsync: mock(async (_id: string) => {}), isPending: false };
const access = { data: { shares: [{ targetId: 'ada@example.org', permission: 'write' }] } };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendar,
    useUpdateSharedCalendar: () => updateShared,
    useDeleteSharedCalendar: () => deleteShared,
    useCalendarAccess: () => access,
}));
// A person row names them by address or id, without looking up who they are.
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email, userId }: { email?: string; userId?: string }) => ({
        displayName: email ?? userId ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/calendar', () => realCalendar);
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
const { SharedCalendarConfigDialog } = await import('../../components/shared-calendar-config-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    for (const mutation of [updateShared, deleteShared]) {
        mutation.mutateAsync.mockReset();
        mutation.mutateAsync.mockImplementation(async () => {});
    }
    onOpenChange.mockClear();
    unhandled.length = 0;
});

// The dialog under a parent that owns `open`, as the sidebar does.
function Harness({ item }: { item: SharedCalendar }) {
    const [open, setOpen] = useState(true);
    return createElement(SharedCalendarConfigDialog, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        sharedCalendar: item,
    });
}

async function open(item: SharedCalendar) {
    ({ unmount } = await renderInDocument(createElement(Harness, { item })));
}

const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const dialogTitled = (title: string) => dialogs().find((d) => d.querySelector('h2')?.textContent === title);
const settings = () => dialogTitled('Shared calendar settings');
const button = (dialog: Element | undefined, label: string) =>
    [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => (b.textContent || b.getAttribute('aria-label')) === label,
    );
const click = (target: HTMLButtonElement | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('it names the calendar and the access in the share words, and lists the owner and the people with access', async () => {
    await open(shared({}));
    expect(settings()?.querySelector('[data-slot="dialog-description"]')?.textContent).toBe('Team — Can view');
    expect(settings()?.textContent).toContain('People with access');
    expect(settings()?.textContent).toContain('ada@example.org');
    expect(settings()?.textContent).toContain('Can edit');
});

test('free/busy access reads as the share editor says it', async () => {
    await open(shared({ permission: 'free-busy' }));
    expect(settings()?.querySelector('[data-slot="dialog-description"]')?.textContent).toBe('Team — Free/Busy');
});

test("Save with the owner's color stores none, and the dialog closes", async () => {
    await open(shared({}));
    await click(button(settings(), 'Save'));
    await settle();
    expect(updateShared.mutateAsync.mock.calls).toEqual([[{ id: 'sc1', color: null }]]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test("Save keeps the user's own color", async () => {
    await open(shared({ color: '#f97316' }));
    await click(button(settings(), 'Save'));
    await settle();
    expect(updateShared.mutateAsync.mock.calls).toEqual([[{ id: 'sc1', color: '#f97316' }]]);
});

test('a save the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    updateShared.mutateAsync.mockImplementation(async () => {
        throw toasted('offline');
    });
    await open(shared({}));
    await click(button(settings(), 'Save'));
    await settle();
    expect(updateShared.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
});

test('Remove asks on top of the open dialog, and a yes removes it and closes', async () => {
    await open(shared({}));
    await click(button(settings(), 'Remove calendar'));
    expect(dialogTitled('Remove shared calendar')?.querySelector('p')?.innerHTML).toBe(
        'Remove <strong>Team</strong> from your view? You can be re-added by the owner.',
    );
    expect(button(dialogTitled('Remove shared calendar'), 'Remove')?.getAttribute('data-variant')).toBe('destructive');
    expect(settings()).toBeDefined();
    await click(button(dialogTitled('Remove shared calendar'), 'Cancel'));
    expect(settings()).toBeDefined();

    await click(button(settings(), 'Remove calendar'));
    await click(button(dialogTitled('Remove shared calendar'), 'Remove'));
    await settle();
    expect(deleteShared.mutateAsync.mock.calls).toEqual([['sc1']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
    expect(dialogs()).toEqual([]);
});

test("a team's calendar can't be removed and lists no people", async () => {
    await open(shared({ ownerUserId: teamOwnerId('0123456789abcdef0123456789abcdef') }));
    expect(button(settings(), 'Remove calendar')).toBeUndefined();
    expect(settings()?.textContent).not.toContain('People with access');
});
