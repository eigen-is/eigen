// Server settings keeps the page contract, and saves only the drafts that changed: a new organization name alone
// writes the name and nothing else. Send test mail is a button of its own, so Enter in a field saves rather than
// sending, and a click sends without saving. Each landing link's remove button is named after the link: its title,
// its URL when the title is empty, or "empty link" for a row with neither, so a screen reader hears which one goes.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
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
const saveOrgName = mock(async (_name: string) => {});
const saveSettings = mock(async () => ({}));
const sendTestMail = mock(() => {});
afterEach(() => {
    for (const save of [saveOrgName, saveSettings, sendTestMail]) save.mockClear();
});

// The settings hooks and the public config are stubbed so the page needs no server, and the sections this test
// doesn't read draw nothing. Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts
// the originals back.
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => ({ data: SETTINGS, isLoading: false }),
    useServerS3Config: () => ({ data: undefined }),
    useServerStatus: () => ({ data: undefined }),
    useUpdateServerSettings: () => ({ ...mutation, mutateAsync: saveSettings }),
    useUpdateServerS3Config: () => mutation,
    useCheckS3Connection: () => mutation,
    useHardenS3Bucket: () => mutation,
    useUpdateOrgName: () => ({ ...mutation, mutateAsync: saveOrgName }),
    useSendTestMail: () => ({ ...mutation, mutate: sendTestMail }),
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
afterAll(() => {
    mock.module('@workspace/lib/settings', () => realSettings);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('../../../components/admin/server-backup-section', () => realBackup);
    mock.module('../../../components/admin/server-status-section', () => realStatus);
    mock.module('../../../components/admin/storage-type-picker', () => realPicker);
});

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { ServerSettingsPage } = await import('../../../components/admin/server-settings');

async function openPage() {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component: ServerSettingsPage });
    const memory = router.createRouter({
        routeTree: root.addChildren([page]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    return renderInDocument(createElement(router.RouterProvider, { router: memory }));
}

// The field a label names, with what a keystroke sets: React reads the value off its own tracker.
function field(label: string): HTMLInputElement {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
}
const type = (label: string, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(label), value);
        field(label).dispatchEvent(new Event('input', { bubbles: true }));
    });
const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);

test('Server settings keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(ServerSettingsPage),
        submitLabel: 'Save',
        firstField: 'Organization name',
        onSubmit: saveOrgName,
        makeChanged: () => type('Organization name', 'Acme Labs'),
        makeInvalid: () => type('Organization name', ' '),
        invalidField: 'Organization name',
    });
});

test('a new organization name alone saves the trimmed name and nothing else', async () => {
    await openPage();
    await type('Organization name', ' Acme Labs ');
    await act(async () => pressEnter(field('Organization name')));
    expect(saveOrgName.mock.calls).toEqual([['Acme Labs']]);
    expect(saveSettings).not.toHaveBeenCalled();
});

test('a change put back by hand leaves nothing to save', async () => {
    await openPage();
    await type('Organization name', 'Acme Labs');
    expect(button('Save')).toBeDefined();
    await type('Organization name', 'Acme');
    expect(button('Save')).toBeUndefined();
});

test('Send test mail sends without saving, and Enter in a field saves rather than sending', async () => {
    await openPage();
    const send = button('Send test mail');
    expect(send?.type).toBe('button');
    await act(async () => send?.click());
    expect(sendTestMail).toHaveBeenCalledTimes(1);
    expect(saveSettings).not.toHaveBeenCalled();

    await type('Max upload (MB)', '50');
    await act(async () => pressEnter(field('Max upload (MB)')));
    expect(sendTestMail).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);
});

test("each landing link's remove button is named after the link's title, else its URL", async () => {
    const { container } = await openPage();
    const buttonNamed = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

    expect(buttonNamed('Remove Docs')).not.toBeNull();
    expect(buttonNamed('Remove https://blog.example.com')).not.toBeNull();
    expect(buttonNamed('Remove')).toBeNull();

    const addButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add button');
    if (!addButton) throw new Error('the page drew no Add button');
    await act(async () => addButton.click());
    expect(buttonNamed('Remove empty link')).not.toBeNull();
});
