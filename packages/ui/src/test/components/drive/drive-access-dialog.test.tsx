// The Share dialog lists who has access and saves only what changed, then closes. Save waits for a change, Enter in
// the contact field adds that person and saves nothing, and a save that fails stays open with the edits kept. Cancel
// waits while a save runs. The lock and the read-only list's header are buttons the keyboard reaches. The owner gets
// the Share with team menu, and a viewer who may only look gets Close alone.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import type { DirectAccessItem, InheritedAccessItem } from '@workspace/lib/types/drive-access';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';
import { pressKey } from '../../press-key';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The people and contacts the rows look up.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);

const OWNER: DirectAccessItem = { id: 'owner@example.com', read: true, write: true, owner: true };
const ADA: DirectAccessItem = { id: 'ada@example.com', read: true, write: true, owner: false };
const BOB: DirectAccessItem = { id: 'bob@example.com', read: true, write: false, owner: false };
const ERIN: DirectAccessItem = { id: 'erin@example.com', read: true, write: false, owner: false };
const CAROL: InheritedAccessItem = { id: 'carol@example.com', read: true, write: false, sourceFolderName: 'Projects' };

// What the Drive hooks answer, which a test changes before it opens the dialog.
let baseDirectList: DirectAccessItem[] = [];
let isGuest = false;
let isEffectiveOwner = true;
let canWrite = true;
let myTeams: { id: string; name: string }[] = [];

const updateACL = mock(async (_variables: unknown) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realHome = { ...(await import('@workspace/lib/home')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useUpdateACL: () => ({ mutateAsync: updateACL }),
    useIsEffectiveOwner: () => isEffectiveOwner,
    useCheckPermissions: () => ({ data: { canRead: true, canWrite } }),
    useDriveAccess: (path: DrivePath, override?: DirectAccessItem[]) => {
        // A second item, which Erin can see and nobody else.
        const base = path.id === plans.id ? [OWNER, ERIN] : baseDirectList;
        return {
            baseDirectList: base,
            directList: override ?? base,
            inheritedList: [CAROL],
            allEntries: [...base, { ...CAROL, inherited: true }],
        };
    },
}));
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: OWNER.id } }),
    useIsGuest: () => isGuest,
}));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: myTeams }) }));
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useContactSuggestions: () => ({ suggestions: [], isLoading: false }),
}));
// Each row shows the person's email as their name.
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
    fetchSpy.mockRestore();
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/home', () => realHome);
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { DriveAccessDialog } = await import('../../../components/drive/drive-access-dialog');

const notes = drivePath({ id: 'notes', name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC });
const plans = drivePath({ id: 'plans', name: 'Plans.eigendoc', mimeType: DRIVE_MIME_DOC });
const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    updateACL.mockReset();
    updateACL.mockImplementation(async () => {});
    onOpenChange.mockClear();
    baseDirectList = [OWNER, ADA, BOB];
    isGuest = false;
    isEffectiveOwner = true;
    canWrite = true;
    sharedPath = notes;
    myTeams = [];
});

// The dialog under a parent that owns `open`, as Drive's item menu does.
let sharedPath = notes;
function Harness() {
    const [open, setOpen] = useState(true);
    return createElement(DriveAccessDialog, {
        path: sharedPath,
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
    });
}

async function open() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
}

// The dialog as Drive's folder page hosts it: the page takes the item out of its URL when Share closes, so the path
// goes back to null.
function PageHarness() {
    const [path, setPath] = useState<DrivePath | null>(notes);
    return createElement(DriveAccessDialog, {
        path,
        open: path !== null,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            if (!next) setPath(null);
        },
    });
}

// The dialog as an editor route hosts it: Back or Forward swaps the item while Share stays open.
let showPath = (_path: DrivePath) => {};
function RouteHarness() {
    const [path, setPath] = useState(notes);
    const [open, setOpen] = useState(true);
    showPath = setPath;
    return createElement(DriveAccessDialog, {
        path,
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
    });
}

const dialog = () => document.querySelector('[role="dialog"]');
// The footer's buttons, apart from the corner X, which a screen reader calls Close too.
const footerButtons = () => [
    ...(dialog()?.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button') ?? []),
];
const button = (label: string) => footerButtons().find((b) => b.textContent === label);
// happy-dom doesn't disable a button inside a disabled fieldset, which a browser does.
const isDisabled = (target: HTMLButtonElement | undefined) =>
    !!target && (target.disabled || target.closest('fieldset')?.disabled === true);
const click = (target: Element | null | undefined) =>
    act(async () => {
        if (!target) throw new Error('nothing to click');
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const contactField = () => {
    const input = dialog()?.querySelector<HTMLInputElement>('input[placeholder="Enter email addresses"]');
    if (!input) throw new Error('the dialog has no contact field');
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeContact = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(contactField(), value);
        contactField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const addByEnter = async (email: string) => {
    await typeContact(email);
    await act(async () => pressEnter(contactField()));
    await settle();
};

// Each person's row: their name, which here is their email, and the access shown beside it, in a picker or as text.
const rows = () =>
    [...(dialog()?.querySelectorAll('[data-slot="avatar"]') ?? [])].map((a) => a.parentElement?.parentElement);
const people = () =>
    rows().map((row) => {
        const access = row?.querySelector('[data-slot="select-trigger"]') ?? row?.children[1];
        return `${row?.querySelector('p')?.textContent}: ${access?.textContent}`;
    });

// The General access lock, by the action its name says it takes.
const OPEN_LINK = 'Let anyone signed in with the link view it';
const RESTRICT = 'Restrict to people with access';
const lock = (name: string) => {
    const found = dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    if (!found) throw new Error(`the dialog has no lock named ${name}`);
    return found;
};
const generalAccess = () => (dialog()?.textContent?.includes('Unrestricted') ? 'Unrestricted' : 'Restricted');

async function chooseAccess(email: string, label: string) {
    const row = rows().find((r) => r?.querySelector('p')?.textContent === email);
    await click(row?.querySelector('[data-slot="select-trigger"]'));
    // Radix portals the open list to the body.
    await click(
        [...document.querySelectorAll('[data-slot="select-content"] [role="option"]')].find(
            (option) => option.textContent?.trim() === label,
        ),
    );
}

test('Share lists who has access, and Save waits for a change', async () => {
    await open();
    expect(dialog()?.querySelector('h2')?.textContent).toBe("Share 'Notes'");
    expect(people()).toEqual([
        'owner@example.com: Owner',
        'ada@example.com: Editor',
        'bob@example.com: Viewer',
        'carol@example.com: Viewer',
    ]);
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Cancel', 'Save']);
    expect(button('Save')?.disabled).toBe(true);
});

test('Enter in the contact field adds the person and saves nothing', async () => {
    await open();
    await addByEnter('dan@example.com');
    expect(people()).toContain('dan@example.com: Editor');
    expect(contactField().value).toBe('');
    expect(button('Save')?.disabled).toBe(false);

    // An empty field takes Enter too, so a pending change is still not saved.
    await act(async () => pressEnter(contactField()));
    await settle();
    expect(updateACL).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Save sends exactly what changed and closes once it is saved', async () => {
    await open();
    await addByEnter('dan@example.com');
    await chooseAccess('ada@example.com', 'Remove');
    await chooseAccess('bob@example.com', 'Editor');
    await click(lock(OPEN_LINK));
    await click(dialog()?.querySelector('[role="checkbox"]'));
    await click(button('Save'));
    await settle();
    expect(updateACL.mock.calls).toEqual([
        [
            {
                path: notes,
                add: [
                    { id: 'bob@example.com', read: true, write: true },
                    { id: 'dan@example.com', read: true, write: true },
                ],
                remove: ['ada@example.com'],
                visibility: 'public-read',
                sharingRestricted: true,
            },
        ],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('the lock is a button that says what it does, and Enter, Space or a click flips it', async () => {
    await open();
    expect(generalAccess()).toBe('Restricted');
    await act(async () => pressKey(lock(OPEN_LINK), 'Enter'));
    expect(generalAccess()).toBe('Unrestricted');
    await act(async () => pressKey(lock(RESTRICT), ' '));
    expect(generalAccess()).toBe('Restricted');
    await click(lock(OPEN_LINK));
    expect(generalAccess()).toBe('Unrestricted');
    await click(button('Save'));
    await settle();
    expect(updateACL.mock.calls).toEqual([
        [expect.objectContaining({ add: [], remove: [], visibility: 'public-read' })],
    ]);
});

test('a save that fails stays open with the edits kept, and Cancel waits while a save runs', async () => {
    let fail = () => {};
    updateACL.mockImplementationOnce(
        () =>
            new Promise<void>((_resolve, reject) => {
                // The mutation hook toasts its failure before the dialog sees it.
                fail = () => {
                    const failure = new Error('offline');
                    onMutationError(failure);
                    reject(failure);
                };
            }),
    );
    await open();
    await addByEnter('dan@example.com');
    await click(button('Save'));
    await settle();
    expect(isDisabled(button('Cancel'))).toBe(true);
    expect(isDisabled(button('Save'))).toBe(true);

    await act(async () => fail());
    await settle();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(people()).toContain('dan@example.com: Editor');
    expect(isDisabled(button('Cancel'))).toBe(false);
    expect(isDisabled(button('Save'))).toBe(false);

    await click(button('Save'));
    await settle();
    expect(updateACL.mock.calls.at(-1)).toEqual([
        expect.objectContaining({ add: [{ id: 'dan@example.com', read: true, write: true }], remove: [] }),
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('the envelope closes Share and opens Email collaborators, also where the host drops the path', async () => {
    for (const host of [Harness, PageHarness]) {
        ({ unmount } = await renderInDocument(createElement(host)));
        await click(dialog()?.querySelector('button[aria-label="Email collaborators"]'));
        await settle();
        expect(onOpenChange.mock.calls).toEqual([[false]]);
        const titles = [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent);
        expect([host.name, ...titles]).toEqual([host.name, 'Email collaborators']);
        await unmount();
        onOpenChange.mockClear();
    }
});

test('another item opens with its own list, and a refetch of the same item keeps the edits', async () => {
    ({ unmount } = await renderInDocument(createElement(RouteHarness)));
    await addByEnter('dan@example.com');
    await act(async () => showPath({ ...notes, updatedAt: new Date('2026-09-21T09:00:00Z') }));
    expect(people()).toContain('dan@example.com: Editor');
    expect(button('Save')?.disabled).toBe(false);

    await act(async () => showPath(plans));
    expect(dialog()?.querySelector('h2')?.textContent).toBe("Share 'Plans'");
    expect(people()).toEqual(['owner@example.com: Owner', 'erin@example.com: Viewer', 'carol@example.com: Viewer']);
    expect(button('Save')?.disabled).toBe(true);
});

test('Email collaborators for one item closes when the host moves to another', async () => {
    ({ unmount } = await renderInDocument(createElement(RouteHarness)));
    await click(dialog()?.querySelector('button[aria-label="Email collaborators"]'));
    await settle();
    const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent);
    expect(titles()).toEqual(['Email collaborators']);
    await act(async () => showPath(plans));
    await settle();
    expect(titles()).toEqual([]);
});

test('the owner shares with a team from the footer menu', async () => {
    myTeams = [{ id: 'design', name: 'Design' }];
    await open();
    await click(button('Share with team'));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Design'));
    await click(button('Save'));
    await settle();
    expect(updateACL.mock.calls).toEqual([
        [expect.objectContaining({ add: [{ id: teamOwnerId('design'), read: true, write: true }], remove: [] })],
    ]);
});

test('a viewer who may only look sees the list and Close alone', async () => {
    isGuest = true;
    await open();
    expect(dialog()?.textContent).toContain('Sharing is restricted by the owner.');
    expect(dialog()?.querySelector('input[placeholder="Enter email addresses"]')).toBeNull();
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Close']);

    // Four people collapse the list under a header the keyboard opens.
    const header = dialog()?.querySelector('button[aria-expanded]');
    if (!header) throw new Error('the list has no header button');
    expect(header.textContent).toBe('4 people with access');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    await act(async () => pressKey(header, 'Enter'));
    expect(header.getAttribute('aria-expanded')).toBe('true');

    await click(button('Close'));
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

// Chat's share summary opens Share for every member, and the server refuses a save from one who may not write.
test('a member who may not write sees the list, a line that says so and Close alone', async () => {
    isEffectiveOwner = false;
    canWrite = false;
    await open();
    expect(dialog()?.textContent).toContain('You can view who has access.');
    expect(dialog()?.textContent).not.toContain('Sharing is restricted by the owner.');
    expect(dialog()?.querySelector('input[placeholder="Enter email addresses"]')).toBeNull();
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Close']);
});

test('an editor edits the list, unless the owner restricted sharing', async () => {
    isEffectiveOwner = false;
    await open();
    expect(dialog()?.querySelector('input[placeholder="Enter email addresses"]')).not.toBeNull();
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Cancel', 'Save']);
    await unmount();

    sharedPath = { ...notes, sharingRestricted: true };
    await open();
    expect(dialog()?.textContent).toContain('Sharing is restricted by the owner.');
    expect(footerButtons().map((b) => b.textContent)).toEqual(['Close']);
});

// Who may edit and who may only look see one general access block, in the same words as the lock's name.
test('an open link reads the same to whoever opens Share, with the role it gives beside it', async () => {
    sharedPath = { ...notes, visibility: 'public-read' };
    await open();
    expect(dialog()?.textContent).toContain('UnrestrictedAnyone signed in with the link');
    expect(dialog()?.textContent).toContain('Can view');
    await unmount();

    isGuest = true;
    sharedPath = { ...notes, visibility: 'public-write' };
    await open();
    expect(dialog()?.textContent).toContain('UnrestrictedAnyone signed in with the link');
    expect(dialog()?.textContent).toContain('Can edit');
    expect(dialog()?.textContent).not.toContain('authenticated');
});
