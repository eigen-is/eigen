// Uploading an archive is the owner's alone: another admin's Backup section offers no Upload backup. A restore or
// delete asks first in one red confirm that names the copy it acts on.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { BackupSafetyCopy } from '@workspace/lib/types/backup';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

let isOwner = false;
const backups: { artifacts: never[]; safetyCopies: BackupSafetyCopy[] } = { artifacts: [], safetyCopies: [] };
const mutation = { isPending: false, mutate: () => {}, mutateAsync: async () => {} };
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useIsOrgOwner: () => isOwner,
    useBackupArtifacts: () => ({ data: backups, isLoading: false, isError: false }),
    useBackupJobs: () => ({ data: [], isError: false }),
    useStartBackup: () => mutation,
    useUploadBackup: () => mutation,
    useVerifyBackup: () => mutation,
    useRestoreBackup: () => mutation,
    useRestoreSafetyCopy: () => mutation,
    useDeleteBackupArtifact: () => mutation,
    useDeleteSafetyCopy: () => mutation,
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement } = await import('react');
const { BackupSection } = await import('../../../components/admin/backup-section');

let unmount = async () => {};
afterEach(() => unmount());

test('the owner sees Upload backup, and another admin does not', async () => {
    ({ unmount } = await renderInDocument(createElement(BackupSection, { ownerId: 'user-1' })));
    expect(document.body.textContent).toContain('Create backup');
    expect(document.body.textContent).not.toContain('Upload backup');
    await unmount();

    isOwner = true;
    ({ unmount } = await renderInDocument(createElement(BackupSection, { ownerId: 'user-1' })));
    expect(document.body.textContent).toContain('Upload backup');
});

test('Restore this copy asks in a red confirm that names the copy', async () => {
    const name = 'user-1.pre-restore-20261101-120000';
    backups.safetyCopies = [{ name, kind: 'pre-restore', createdAt: new Date(), bytes: 1024, truncated: false }];
    ({ unmount } = await renderInDocument(createElement(BackupSection, { ownerId: 'user-1' })));
    const restore = document.querySelector('button[aria-label="Restore this copy"]');
    await act(async () => {
        restore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('Restore this safety copy');
    expect(dialog?.querySelector('p')?.innerHTML).toBe(
        `Restore the copy <strong>${name}</strong>? The account goes back to the state this copy holds, and the state ` +
            "it is in now becomes a new safety copy beside it. Drive files on a remote mount are restored from the copy's " +
            'own bucket objects.',
    );
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Restore');
    expect(confirm?.getAttribute('data-variant')).toBe('destructive');
});
