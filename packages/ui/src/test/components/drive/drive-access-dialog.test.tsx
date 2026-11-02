// The Share dialog saves what changed and closes once it is saved. A save that fails stays open with Cancel and Save
// still there, so the user can try again or give up.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The people and contacts the rows look up.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: fetch.preconnect }),
);

const updateACL = mock(async (_variables: unknown) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realHome = { ...(await import('@workspace/lib/home')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useUpdateACL: () => ({ mutateAsync: updateACL }),
    useIsEffectiveOwner: () => true,
    useCheckPermissions: () => ({ data: { canWrite: true } }),
    useDriveAccess: () => ({ baseDirectList: [], directList: [], inheritedList: [] }),
}));
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: 'owner@example.com' } }),
    useIsGuest: () => false,
}));
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: [] }) }));
afterAll(() => {
    fetchSpy.mockRestore();
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/home', () => realHome);
});

const { act, createElement, useState } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { DriveAccessDialog } = await import('../../../components/drive/drive-access-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    updateACL.mockReset();
    updateACL.mockImplementation(async () => {});
    onOpenChange.mockClear();
});

function Harness() {
    const [open, setOpen] = useState(true);
    return createElement(DriveAccessDialog, {
        path: drivePath({ id: 'notes', name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC }),
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
    });
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label);
const click = (target: Element | null | undefined) =>
    act(async () => {
        if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
        target.click();
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

// Turning "Editors can share" off is a change, so Done becomes Save.
async function openWithAChange() {
    ({ unmount } = await renderInDocument(createElement(Harness)));
    await click(dialog()?.querySelector('[role="checkbox"]'));
}

test('Save hands the change on and closes once it is saved', async () => {
    await openWithAChange();
    await click(button('Save'));
    await settle();
    expect(updateACL.mock.calls).toEqual([
        [expect.objectContaining({ add: [], remove: [], visibility: 'private', sharingRestricted: true })],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a save that fails keeps Cancel and Save for another try', async () => {
    updateACL.mockImplementationOnce(async () => {
        // The mutation hook toasts its failure before the dialog sees it.
        const failure = new Error('offline');
        onMutationError(failure);
        throw failure;
    });
    await openWithAChange();
    await click(button('Save'));
    await settle();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Cancel')?.disabled).toBe(false);
    expect(button('Save')?.disabled).toBe(false);

    await click(button('Save'));
    await settle();
    expect(updateACL).toHaveBeenCalledTimes(2);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
