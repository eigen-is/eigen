// Server settings keeps the page contract, and its one save carries only the drafts that changed: a new organization
// name alone sends the name and nothing else, and an emptied one says so only once Save was pressed. Send test mail is a button of its own, so Enter in a field saves rather than
// sending, and a click sends without saving. Each landing link's remove button is named after the link: its title,
// its URL when the title is empty, or "empty link" for a row with neither, so a screen reader hears which one goes. A
// save refused for an incomplete bucket says which field under it and focuses that field. Each switch is named by its
// label and described by its sentence.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { ServerSettings } from '@workspace/lib/types/settings';
import { expectFormContract, field, type } from '@workspace/ui/test/form-contract';
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
    sharing: { publicLinks: false },
};
let settings = SETTINGS;
const mutation = { mutate: () => {}, mutateAsync: async () => {}, isPending: false };
const save = mock(async (_parts: object) => null);
const sendTestMail = mock(() => {});
afterEach(() => {
    settings = SETTINGS;
    save.mockClear();
    sendTestMail.mockClear();
});

// The settings hooks and the public config are stubbed so the page needs no server, and the sections this test
// doesn't read draw nothing. Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts
// the originals back.
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => ({ data: settings, isLoading: false }),
    useServerS3Config: () => ({ data: undefined }),
    useServerStatus: () => ({ data: undefined }),
    useSaveServerSettingsPage: () => ({ ...mutation, mutateAsync: save }),
    useCheckS3Connection: () => mutation,
    useHardenS3Bucket: () => mutation,
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
afterAll(() => {
    mock.module('@workspace/lib/settings', () => realSettings);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('../../../components/admin/server-backup-section', () => realBackup);
    mock.module('../../../components/admin/server-status-section', () => realStatus);
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

const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);

test('Server settings keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(ServerSettingsPage),
        submitLabel: 'Save',
        firstField: 'Organization name',
        onSubmit: save,
        makeChanged: () => type('Organization name', 'Acme Labs'),
        makeInvalid: () => type('Organization name', ' '),
        invalidField: 'Organization name',
    });
});

test('a new organization name alone saves the trimmed name and nothing else', async () => {
    await openPage();
    await type('Organization name', ' Acme Labs ');
    await act(async () => pressEnter(field('Organization name')));
    expect(save.mock.calls).toEqual([[{ orgName: 'Acme Labs', s3Config: undefined, settings: undefined }]]);
});

test('an emptied organization name says so only once Save was pressed', async () => {
    await openPage();
    await type('Organization name', '');
    expect(document.body.textContent).not.toContain('Add a name');
    await act(async () => button('Save')?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(save).not.toHaveBeenCalled();
    const name = field('Organization name');
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Add a name');
    expect(document.activeElement).toBe(name);
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
    expect(save).not.toHaveBeenCalled();

    await type('Max upload (MB)', '50');
    await act(async () => pressEnter(field('Max upload (MB)')));
    expect(sendTestMail).toHaveBeenCalledTimes(1);
    expect(save.mock.calls).toEqual([
        [{ orgName: undefined, s3Config: undefined, settings: { quotas: { maxUploadSizeMB: 50 } } }],
    ]);
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

test('a save refused for an incomplete bucket says so under the field and focuses it', async () => {
    settings = { ...SETTINGS, defaults: { mount: { storageType: 's3' } } };
    await openPage();
    await type('Organization name', 'Acme Labs');
    await act(async () => button('Save')?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field('Endpoint'));
    expect(document.getElementById(field('Endpoint').getAttribute('aria-describedby') ?? '')?.textContent).toBe(
        'Add an endpoint',
    );
});

test('each notification switch is named by its label and described by its sentence', async () => {
    await openPage();
    const tag = [...document.querySelectorAll('label')].find(
        (l) => l.textContent === 'Email users for calendar invites',
    );
    const toggle = tag && document.getElementById(tag.htmlFor);
    expect(toggle?.getAttribute('role')).toBe('switch');
    const description = document.getElementById(toggle?.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe("An invitation can't wait, and Google Calendar and Outlook email it too.");
});
