// Add mount and Edit mount, as a team's storage section opens them. Each shows the name, the storage type, the size
// and, for a bucket, the S3 fields, and its submit waits for a name, a size of at least 10 MB and a full S3 config. A
// save hands the trimmed name, the size and the S3 config to the mount hook and closes. A save the server refuses keeps
// the dialog open with what was typed. Enter in a field submits, and never clicks a button inside the S3 card first.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult } from '@workspace/lib/types/settings';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const bucket: S3Config = {
    endpoint: 'https://s3.example.org',
    bucket: 'team-files',
    prefix: 'eigen',
    accessKeyId: 'AKIA1',
    secretAccessKey: 'secret',
};

type AddInput = { name: string; storageType?: string; maxSizeMB?: number; s3Config?: S3Config };
type UpdateInput = { mountId: string; enabled?: boolean; maxSizeMB?: number; name?: string; s3Config?: S3Config };
const addMount = { mutateAsync: mock(async (_input: AddInput) => {}) };
const updateMount = { mutateAsync: mock(async (_input: UpdateInput) => {}) };
const checkS3 = { mutateAsync: mock(async (_config: S3Config): Promise<S3CheckResult> => ({ ok: true, message: '' })) };
const hardenS3 = {
    mutateAsync: mock(async (_input: S3Config & { noncurrentDays: number }) => ({
        ok: true,
        message: 'Bucket is safe',
        applied: { versioning: true, lifecycle: true },
    })),
};
const mounts = {
    data: {
        files: { name: 'Shared', storageType: 'local', maxSizeMB: 500, enabled: true },
        archive: { name: 'Archive', storageType: 's3', maxSizeMB: 2000, enabled: true, s3Config: bucket },
    },
};
// The fields of the server settings the section reads. Replaced per test: the defaults decide which storage type Add
// mount starts on.
type MountDefaults = {
    defaults: { mount: { storageType: string; s3Config?: S3Config } };
    quotas: { defaultMountMaxSizeMB: number };
};
let serverSettings: { data?: MountDefaults } = {};

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realTeam = { ...(await import('@workspace/lib/team')) };
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/team', () => ({
    ...realTeam,
    useTeamMounts: () => mounts,
    useAddTeamMount: () => addMount,
    useUpdateTeamMount: () => updateMount,
}));
mock.module('@workspace/lib/settings', () => ({
    ...realSettings,
    useServerSettings: () => serverSettings,
    useCheckS3Connection: () => checkS3,
    useHardenS3Bucket: () => hardenS3,
}));
afterAll(() => {
    mock.module('@workspace/lib/team', () => realTeam);
    mock.module('@workspace/lib/settings', () => realSettings);
});

// A rejected save the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');
const { TeamMountsSection } = await import('../../../components/admin/team-mounts-section');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};

const writeText = mock(async (_text: string) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    addMount.mutateAsync.mockReset();
    addMount.mutateAsync.mockImplementation(async () => {});
    updateMount.mutateAsync.mockReset();
    updateMount.mutateAsync.mockImplementation(async () => {});
    checkS3.mutateAsync.mockReset();
    checkS3.mutateAsync.mockImplementation(async () => ({ ok: true, message: '' }));
    hardenS3.mutateAsync.mockClear();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serverSettings = {};
    unhandled.length = 0;
});

const s3Defaults: MountDefaults = {
    defaults: { mount: { storageType: 's3', s3Config: bucket } },
    quotas: { defaultMountMaxSizeMB: 1000 },
};

async function renderSection() {
    ({ unmount } = await renderInDocument(createElement(TeamMountsSection, { teamId: 'team-1' })));
}

const dialog = () => document.querySelector('[role="dialog"]');
const title = () => dialog()?.querySelector('h2')?.textContent;
const buttons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
const button = (label: string) => buttons().find((b) => b.textContent === label);
const field = (selector: string) => {
    const input = dialog()?.querySelector(selector);
    if (!(input instanceof HTMLInputElement)) throw new Error(`the dialog has no ${selector}`);
    return input;
};
const nameField = () => field('input[placeholder="e.g. shared files"]');
const sizeField = () => field('input[type="number"]');
const s3Field = (placeholder: string) => field(`input[placeholder="${placeholder}"]`);
const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
const click = (target: Element | null | undefined) =>
    act(async () => {
        if (!(target instanceof HTMLElement)) throw new Error('nothing to click');
        target.click();
    });
const enter = (input: HTMLInputElement) => act(async () => pressEnter(input));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function openAdd() {
    await renderSection();
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add'));
}

async function openEdit(mountName: string) {
    await renderSection();
    const row = [...document.querySelectorAll('.border.rounded-lg')].find((r) => r.textContent?.includes(mountName));
    await click(row?.querySelector('button[aria-label="Mount settings"]'));
}

test('Add mount shows a name, the storage type and the size, and starts disabled', async () => {
    await openAdd();
    expect(title()).toBe('Add mount');
    expect(nameField().value).toBe('');
    expect(dialog()?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe('Local (full names)');
    expect(sizeField().value).toBe('500');
    expect(dialog()?.textContent).not.toContain('S3 configuration');
    expect(button('Cancel')?.disabled).toBe(false);
    expect(button('Create mount')?.disabled).toBe(true);
});

test('Enter in the name field adds a local mount with the trimmed name, and the dialog closes', async () => {
    await openAdd();
    await type(nameField(), '  Shared  ');
    await enter(nameField());
    await settle();
    expect(addMount.mutateAsync.mock.calls).toEqual([
        [{ name: 'Shared', storageType: 'local', maxSizeMB: 500, s3Config: undefined }],
    ]);
    expect(dialog()).toBeNull();
});

test('Add mount on an S3 default hands the bucket on with the size', async () => {
    serverSettings = { data: s3Defaults };
    await openAdd();
    expect(dialog()?.textContent).toContain('S3 configuration');
    expect(sizeField().value).toBe('1000');
    await type(nameField(), 'Media');
    await type(sizeField(), '2500');
    await type(s3Field('my-bucket'), 'media-bucket');
    await click(button('Create mount'));
    await settle();
    expect(addMount.mutateAsync.mock.calls).toEqual([
        [{ name: 'Media', storageType: 's3', maxSizeMB: 2500, s3Config: { ...bucket, bucket: 'media-bucket' } }],
    ]);
    expect(dialog()).toBeNull();
});

test('the submit waits for a name, a size of at least 10 MB and a full S3 config', async () => {
    serverSettings = { data: s3Defaults };
    await openAdd();
    const create = () => button('Create mount');
    expect(create()?.disabled).toBe(true);
    await enter(nameField());
    await type(nameField(), '   ');
    expect(create()?.disabled).toBe(true);
    await type(nameField(), 'Media');
    expect(create()?.disabled).toBe(false);
    await type(sizeField(), '9');
    expect(create()?.disabled).toBe(true);
    await enter(sizeField());
    await type(sizeField(), '10');
    expect(create()?.disabled).toBe(false);
    await type(s3Field('my-bucket'), '');
    expect(create()?.disabled).toBe(true);
    await enter(nameField());
    await settle();
    expect(addMount.mutateAsync).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
});

test('Enter in an S3 field submits the mount, and never clicks Copy or another button in the card', async () => {
    serverSettings = { data: s3Defaults };
    // A key that can't read the bucket settings gets the manual commands, with their Copy button.
    checkS3.mutateAsync.mockImplementation(async () => ({
        ok: true,
        message: 'Connected',
        versioning: 'unknown',
        lifecycle: 'unknown',
    }));
    await openAdd();
    await type(nameField(), 'Media');
    await click(button('Test connection'));
    await settle();
    expect(dialog()?.querySelector('button[aria-label="Copy"]')).not.toBeNull();
    await enter(s3Field('my-bucket'));
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(checkS3.mutateAsync).toHaveBeenCalledTimes(1);
    expect(addMount.mutateAsync.mock.calls).toEqual([
        [{ name: 'Media', storageType: 's3', maxSizeMB: 1000, s3Config: bucket }],
    ]);
});

test('Enter in the bucket safety dialog hardens the bucket and leaves the mount dialog open and unsaved', async () => {
    serverSettings = { data: s3Defaults };
    checkS3.mutateAsync.mockImplementation(async () => ({
        ok: true,
        message: 'Connected',
        versioning: 'disabled',
        lifecycle: 'none',
    }));
    await openAdd();
    await type(nameField(), 'Media');
    await click(button('Test connection'));
    await settle();
    await click(button('Enable safe defaults'));
    const safety = [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.querySelector('h2')?.textContent === 'Make this bucket safe for Eigen',
    );
    const days = safety?.querySelector('input[type="number"]');
    if (!(days instanceof HTMLInputElement)) throw new Error('the safety dialog has no days field');
    await enter(days);
    await settle();
    expect(hardenS3.mutateAsync.mock.calls).toEqual([[{ ...bucket, noncurrentDays: 30 }]]);
    expect(addMount.mutateAsync).not.toHaveBeenCalled();
    expect(title()).toBe('Add mount');
    expect(nameField().value).toBe('Media');
});

test('a save the server refuses keeps the dialog open with what was typed, and no unhandled rejection', async () => {
    addMount.mutateAsync.mockImplementation(async () => {
        throw toasted('A mount with this name exists');
    });
    await openAdd();
    await type(nameField(), 'Shared');
    await type(sizeField(), '800');
    await click(button('Create mount'));
    await settle();
    expect(addMount.mutateAsync).toHaveBeenCalledTimes(1);
    expect(title()).toBe('Add mount');
    expect(nameField().value).toBe('Shared');
    expect(sizeField().value).toBe('800');
    expect(button('Create mount')?.disabled).toBe(false);
    expect(unhandled).toEqual([]);
});

test('Edit mount shows the saved name and size, locks the storage type, and saves the change', async () => {
    await openEdit('Shared');
    expect(title()).toBe('Edit mount');
    expect(nameField().value).toBe('Shared');
    expect(sizeField().value).toBe('500');
    expect(dialog()?.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')?.disabled).toBe(true);
    await type(sizeField(), '750');
    await enter(nameField());
    await settle();
    expect(updateMount.mutateAsync.mock.calls).toEqual([
        [{ mountId: 'files', maxSizeMB: 750, name: 'Shared', s3Config: undefined }],
    ]);
    expect(dialog()).toBeNull();
});

test('Edit mount on a bucket shows its S3 fields and the warning, and saves the changed config', async () => {
    await openEdit('Archive');
    expect(dialog()?.textContent).toContain('Changing S3 settings on an existing mount can break access');
    expect(s3Field('https://s3.amazonaws.com').value).toBe(bucket.endpoint);
    expect(s3Field('my-bucket').value).toBe(bucket.bucket);
    await type(s3Field('optional/path'), 'old');
    await click(button('Save changes'));
    await settle();
    expect(updateMount.mutateAsync.mock.calls).toEqual([
        [{ mountId: 'archive', maxSizeMB: 2000, name: 'Archive', s3Config: { ...bucket, prefix: 'old' } }],
    ]);
    expect(dialog()).toBeNull();
});

test('an edit the server refuses keeps the dialog open with the edited values', async () => {
    updateMount.mutateAsync.mockImplementation(async () => {
        throw toasted('offline');
    });
    await openEdit('Shared');
    await type(nameField(), 'Team files');
    await click(button('Save changes'));
    await settle();
    expect(updateMount.mutateAsync).toHaveBeenCalledTimes(1);
    expect(title()).toBe('Edit mount');
    expect(nameField().value).toBe('Team files');
    expect(unhandled).toEqual([]);
});
