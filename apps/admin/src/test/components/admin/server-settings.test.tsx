// The Landing page section of Server settings gives each link a remove button named after the link: its title, its
// URL when the title is empty, or "empty link" for a row with neither. A screen reader then hears which one it removes.
import { afterAll, expect, mock, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const SETTINGS: ServerSettings = {
    quotas: { homeDataMaxMB: 100, defaultMountMaxSizeMB: 500, maxUploadSizeMB: 35, trashRetentionDays: 30 },
    defaults: { mount: { storageType: 'local-fullnames' } },
    onboarding: {
        waitlist: { enabled: false },
        autoAddOwnerContact: false,
        welcomeMail: { enabled: false, subject: '', body: '' },
        inviteEmail: { subject: '', body: '' },
    },
    guests: { openSignup: false, inactivityDays: 7 },
    landing: {
        links: [
            { title: 'Docs', url: 'https://docs.example.com' },
            { title: ' ', url: 'https://blog.example.com' },
        ],
        showInstall: false,
    },
    notifications: {
        email: {
            guestOnAclAdd: true,
            userOnAclAdd: false,
            userOnCalendarInvite: true,
            ownerOnAccessRequest: true,
            guestOnAssign: true,
            userOnAssign: false,
        },
    },
    mail: { senderName: '', senderAddress: '', relaySendsAsUsers: false },
    backups: {
        schedule: { enabled: false, hourUtc: 2, withS3: false, keep: 7 },
        upload: {
            enabled: false,
            s3: { endpoint: '', bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '' },
            keep: 30,
        },
    },
};
const mutation = { mutate: () => {}, mutateAsync: async () => {}, isPending: false };

// The settings hooks and the public config are stubbed so the page needs no server. The sections this test doesn't
// read draw nothing, and so does the save footer, whose leave guard needs a router. Copies, because mock.module
// rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => ({ data: SETTINGS, isLoading: false }),
    useServerS3Config: () => ({ data: undefined }),
    useServerStatus: () => ({ data: undefined }),
    useUpdateServerSettings: () => mutation,
    useUpdateServerS3Config: () => mutation,
    useCheckS3Connection: () => mutation,
    useHardenS3Bucket: () => mutation,
    useUpdateOrgName: () => mutation,
    useSendTestMail: () => mutation,
}));
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({
        data: { orgId: 'org-1', orgName: 'Acme', domain: 'acme.test', mailDomain: 'acme.test' },
    }),
    useMailEnabled: () => true,
    useHomeDataLabel: () => 'Mail, Contacts & Calendar',
}));
const realBackup = { ...(await import('../../../components/admin/server-backup-section')) };
mock.module('../../../components/admin/server-backup-section', () => ({ ServerBackupSection: () => null }));
const realStatus = { ...(await import('../../../components/admin/server-status-section')) };
mock.module('../../../components/admin/server-status-section', () => ({ ServerStatusSection: () => null }));
const realPicker = { ...(await import('../../../components/admin/storage-type-picker')) };
mock.module('../../../components/admin/storage-type-picker', () => ({ StorageTypePicker: () => null }));
const realUi = { ...(await import('@workspace/ui/components/layout/app')) };
mock.module('@workspace/ui/components/layout/app', () => ({ ...realUi, SettingsFooter: () => null }));
afterAll(() => {
    mock.module('@workspace/lib/settings', () => realSettings);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('../../../components/admin/server-backup-section', () => realBackup);
    mock.module('../../../components/admin/server-status-section', () => realStatus);
    mock.module('../../../components/admin/storage-type-picker', () => realPicker);
    mock.module('@workspace/ui/components/layout/app', () => realUi);
});

const { act, createElement } = await import('react');
const { ServerSettingsPage } = await import('../../../components/admin/server-settings');

test("each landing link's remove button is named after the link's title, else its URL", async () => {
    const { container } = await renderInDocument(createElement(ServerSettingsPage));
    const buttonNamed = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

    expect(buttonNamed('Remove Docs')).not.toBeNull();
    expect(buttonNamed('Remove https://blog.example.com')).not.toBeNull();
    expect(buttonNamed('Remove')).toBeNull();

    const addButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add button');
    if (!addButton) throw new Error('the page drew no Add button');
    await act(async () => addButton.click());
    expect(buttonNamed('Remove empty link')).not.toBeNull();
});
