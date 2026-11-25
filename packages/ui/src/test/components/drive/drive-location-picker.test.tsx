// The location picker keeps the dialog contract in create mode, as New folder and New doc use it. A folder the server
// refuses (403) or a name it won't take (422) keeps it open with the typed name, since a closed dialog would throw it
// away; only a yes/no ConfirmDialog closes on a refusal. A name the folder has already, and a folder the host
// refuses, show their reasons under their fields, until the name or the place changes. A host that moves the place
// keeps what was typed, and a pick alone closes on Esc at once. In folder mode, as Move to uses it, Cmd+Enter confirms.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
// A copy, because mock.module rewrites the loaded module in place, and afterAll puts the original back for the
// field's own test.
const realLocationField = { ...(await import('../../../components/drive/drive-location-field')) };
// What the picker hands its location field, and the way to pick another folder there.
const field: { value?: DriveLocationValue; error?: string; pick: (location: DriveLocationValue) => void } = {
    pick: () => {},
};
mock.module('../../../components/drive/drive-location-field', () => ({
    DriveLocationField: (props: {
        value: DriveLocationValue;
        onChange: (location: DriveLocationValue) => void;
        error?: string;
    }) => {
        field.value = props.value;
        field.error = props.error;
        field.pick = props.onChange;
        return null;
    },
}));
afterAll(() => mock.module('../../../components/drive/drive-location-field', () => realLocationField));

const { act, createElement, useState } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { DriveLocationPicker } = await import('../../../components/drive/drive-location-picker');

let unmount = async () => {};
afterEach(() => unmount());

const onConfirm = mock(async (_location: DriveLocationValue & { name?: string }) => {});
const onOpenChange = mock((_open: boolean) => {});

let moveTo = (_folderId: string) => {};
// The picker under a parent that owns `open` and may move its place, as a host whose teams load late does.
function Harness({
    mode,
    refuseLocation,
}: {
    mode: 'create' | 'folder';
    refuseLocation?: (location: DriveLocationValue) => string | undefined;
}) {
    const [open, setOpen] = useState(true);
    const [folderId, setFolderId] = useState('folder');
    moveTo = setFolderId;
    return createElement(DriveLocationPicker, {
        open,
        onOpenChange: (next: boolean) => {
            onOpenChange(next);
            setOpen(next);
        },
        mode,
        title: mode === 'create' ? 'New folder' : 'Move to',
        nameLabel: 'Folder name',
        confirmLabel: mode === 'create' ? 'Create' : 'Move here',
        onConfirm,
        refuseLocation,
        defaultFolderId: folderId,
    });
}

async function open(mode: 'create' | 'folder', refuseLocation?: (location: DriveLocationValue) => string | undefined) {
    onConfirm.mockReset();
    onConfirm.mockImplementation(async () => {});
    onOpenChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(Harness, { mode, refuseLocation })));
}

const nameField = () => {
    const input = document.querySelector('[role="dialog"] input');
    if (!(input instanceof HTMLInputElement)) throw new Error('no name field');
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeName = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
// A pending button's spinner comes before its label.
const click = (label: string) =>
    act(async () => {
        const button = [...document.querySelectorAll('[role="dialog"] button')].find(
            (b) => b.lastChild?.textContent === label,
        );
        if (!button) throw new Error(`no ${label} button`);
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const fieldError = () => document.querySelector('[role="dialog"] [data-slot="field-error"]')?.textContent;

test('New folder keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Harness, { mode: 'create' }),
        submitLabel: 'Create',
        firstField: 'Folder name',
        onSubmit: onConfirm,
        makeChanged: () => typeName('Plans'),
        makeInvalid: () => typeName('  '),
        invalidField: 'Folder name',
    });
});

test('Create hands on the folder and the trimmed name', async () => {
    await open('create');
    await typeName(' Plans ');
    await click('Create');
    await settle();
    expect(onConfirm.mock.calls).toEqual([
        [{ ownerId: 'owner-1', mountId: 'default', folderId: 'folder', name: 'Plans' }],
    ]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test.each([403, 422])('a %i from the server keeps the picker open with the typed name', async (status) => {
    const failure = new AppError({ error: { status, value: 'No' }, status });
    // A real mutation hook toasts the error before it rejects, which is what lets the picker keep it to itself.
    onMutationError(failure);
    await open('create');
    onConfirm.mockImplementation(() => Promise.reject(failure));
    await typeName('Plans');
    await click('Create');
    await settle();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(nameField().value).toBe('Plans');
});

test('a name the folder has already shows the reason under the field until the name changes', async () => {
    const taken = 'A file or folder named "Plans" already exists in this directory';
    await open('create');
    onConfirm.mockImplementation(() =>
        Promise.reject(new AppError({ status: 409, error: { status: 409, value: taken } })),
    );
    await typeName('Plans');
    await click('Create');
    await settle();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe(taken);
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameField());
    await typeName('Plans 2');
    expect(fieldError()).toBeUndefined();
});

// The name was taken in the folder it was sent to, not in the one picked or moved to since.
test('a name the folder has already loses its reason once another folder is picked or the host moves', async () => {
    const taken = 'A file or folder named "Plans" already exists in this directory';
    for (const move of [
        () => field.pick({ ownerId: 'owner-1', mountId: 'default', folderId: 'other' }),
        () => moveTo('team-folder'),
    ]) {
        await open('create');
        onConfirm.mockImplementation(() =>
            Promise.reject(new AppError({ status: 409, error: { status: 409, value: taken } })),
        );
        await typeName('Plans');
        await click('Create');
        await settle();
        expect(fieldError()).toBe(taken);
        await act(async () => move());
        expect(fieldError()).toBeUndefined();
        expect(nameField().value).toBe('Plans');
        await unmount();
    }
});

test('a host that moves the place keeps the typed name and shows the new place', async () => {
    await open('create');
    await typeName('Plans');
    await act(async () => moveTo('team-folder'));
    expect(nameField().value).toBe('Plans');
    expect(field.value?.folderId).toBe('team-folder');
});

test('a folder the host refuses is named under the location until another is picked', async () => {
    await open('folder', (location) => (location.folderId === 'folder' ? 'Pick another folder' : undefined));
    await click('Move here');
    await settle();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(field.error).toBe('Pick another folder');
    await act(async () => field.pick({ ownerId: 'owner-1', mountId: 'default', folderId: 'other' }));
    expect(field.error).toBeUndefined();
    await click('Move here');
    await settle();
    expect(onConfirm.mock.calls).toEqual([[{ ownerId: 'owner-1', mountId: 'default', folderId: 'other' }]]);
});

test('a folder the host refused loses its reason once the host moves the picker', async () => {
    await open('folder', (location) => (location.folderId === 'folder' ? 'Pick another folder' : undefined));
    await click('Move here');
    await settle();
    expect(field.error).toBe('Pick another folder');
    await act(async () => moveTo('team-folder'));
    expect(field.error).toBeUndefined();
});

test('Cmd+Enter in a folder picker confirms the folder shown', async () => {
    await open('folder');
    const footer = document.querySelector<HTMLElement>('[role="dialog"] [data-slot="dialog-footer"]');
    await act(async () => {
        footer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    await settle();
    expect(onConfirm.mock.calls).toEqual([[{ ownerId: 'owner-1', mountId: 'default', folderId: 'folder' }]]);
});

test('a picker with no name typed closes on Esc at once', async () => {
    for (const mode of ['create', 'folder'] as const) {
        await open(mode);
        await act(async () => {
            (document.activeElement ?? document.body).dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        expect(onOpenChange.mock.calls).toEqual([[false]]);
        await unmount();
    }
});
