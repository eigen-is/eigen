// Uploading an archive is the owner's alone: another admin's Backup section offers no Upload backup.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

let isOwner = false;
const mutation = { isPending: false, mutate: () => {}, mutateAsync: async () => {} };
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useIsOrgOwner: () => isOwner,
    useBackupArtifacts: () => ({ data: { artifacts: [], safetyCopies: [] }, isLoading: false, isError: false }),
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

const { createElement } = await import('react');
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
