// A mount's dialog, new and saved, keeps the dialog contract. Create or Save with a size below the minimum says so under
// Max size and saves nothing, as does a bucket mount with an S3 field missing, which the S3 card marks under itself.
import { expect, mock, test } from 'bun:test';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import type { S3Config } from '@workspace/lib/types/mount';
import { expectFormContract, type } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { FormDialog } = await import('../../../components/form-dialog');
const { MountForm } = await import('../../../components/mount/mount-form');

const bucket: S3Config = {
    endpoint: 'https://s3.example.org',
    bucket: 'team-files',
    prefix: '',
    accessKeyId: 'AKIA1',
    secretAccessKey: 'secret',
};

const save = mock(async (_values: unknown) => {});
const check = mock(async (_config: S3Config) => ({ ok: true, message: '' }));
const harden = mock(async (_config: S3Config, _days: number) => ({
    ok: true,
    message: '',
    applied: { versioning: true, lifecycle: true },
}));

function MountDialog({ edit = false, s3 = false }: { edit?: boolean; s3?: boolean }) {
    const [open, setOpen] = useState(true);
    return createElement(FormDialog, {
        open,
        onOpenChange: setOpen,
        title: edit ? 'Edit mount' : 'Add mount',
        children: createElement(MountForm, {
            onSubmit: save,
            onS3Check: check,
            onS3Harden: harden,
            submitLabel: edit ? 'Save' : 'Create',
            isEdit: edit,
            defaultStorageType: s3 ? 's3' : 'local',
            defaultS3Config: bucket,
            initialValues: edit ? { name: 'Shared', storageType: 'local', maxSizeMB: 500 } : undefined,
        }),
    });
}

const input = (selector: string) => {
    const found = document.querySelector(`[role="dialog"] ${selector}`);
    if (!(found instanceof HTMLInputElement)) throw new Error(`no ${selector}`);
    return found;
};
const nameField = () => input('input[placeholder="e.g. shared files"]');
const sizeField = () => input('input[type="number"]');
const press = (label: string) =>
    act(async () => {
        const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
        if (!found) throw new Error(`no ${label} button`);
        found.focus();
        found.click();
    });

test('Add mount keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(MountDialog),
        submitLabel: 'Create',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type(nameField(), 'Shared'),
        makeInvalid: () => type(nameField(), '  '),
        invalidField: 'Name',
    });
});

test('Edit mount keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(MountDialog, { edit: true }),
        submitLabel: 'Save',
        firstField: 'Name',
        onSubmit: save,
        makeChanged: () => type(sizeField(), '750'),
        makeInvalid: () => type(nameField(), ''),
        invalidField: 'Name',
    });
});

test('a size below the minimum is refused under Max size, and a fitting one saves', async () => {
    save.mockClear();
    const { unmount } = await renderInDocument(createElement(MountDialog));
    await type(nameField(), 'Shared');
    await type(sizeField(), String(QUOTA_MIN_MB - 1));
    await press('Create');
    expect(save).not.toHaveBeenCalled();
    expect(sizeField().getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe(`Use at least ${QUOTA_MIN_MB} MB`);
    expect(document.activeElement).toBe(sizeField());

    await type(sizeField(), String(QUOTA_MIN_MB));
    await press('Create');
    expect(save.mock.calls).toEqual([[{ name: 'Shared', storageType: 'local', maxSizeMB: QUOTA_MIN_MB }]]);
    await unmount();
});

test('a bucket mount with an S3 field missing is refused under that field', async () => {
    save.mockClear();
    const { unmount } = await renderInDocument(createElement(MountDialog, { s3: true }));
    await type(nameField(), 'Media');
    await type(input('input[placeholder="my-bucket"]'), '');
    await press('Create');
    expect(save).not.toHaveBeenCalled();
    expect(input('input[placeholder="my-bucket"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe('Add a bucket');
    await unmount();
});
