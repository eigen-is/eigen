// A location picker whose create or save fails stays open with the typed name, even when the server refused it: a
// read-only folder (403) or a name it won't take (422) is fixed by picking another folder or editing the name, which
// a closed dialog would throw away. Only a yes/no ConfirmDialog closes on a refusal (confirm-dialog.test.tsx).
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
// A copy, because mock.module rewrites the loaded module in place, and afterAll puts the original back for the
// field's own test.
const realLocationField = { ...(await import('../../../components/drive/drive-location-field')) };
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));
afterAll(() => mock.module('../../../components/drive/drive-location-field', () => realLocationField));

const { act, createElement } = await import('react');
const { AppError, onMutationError } = await import('@workspace/lib/api-error');
const { DriveLocationPicker } = await import('../../../components/drive/drive-location-picker');

let unmount = async () => {};
afterEach(() => unmount());

// Opens the New folder picker and types a name, as a keystroke does.
async function openWithName(onConfirm: () => Promise<void>) {
    const onOpenChange = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(
        createElement(DriveLocationPicker, {
            open: true,
            onOpenChange,
            mode: 'create',
            title: 'New folder',
            confirmLabel: 'Create',
            onConfirm,
            defaultFolderId: 'folder',
        }),
    ));
    const input = document.querySelector('#picker-name');
    if (!(input instanceof HTMLInputElement)) throw new Error('no name input');
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Plans');
    await act(async () => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // A pending button's spinner comes before its label.
    const create = [...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.lastChild?.textContent === 'Create',
    );
    if (!create) throw new Error('no create button');
    const clickCreate = () =>
        act(async () => {
            create.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    return { input, create, clickCreate, onOpenChange };
}

async function createFailingWith(status: number) {
    const failure = new AppError({ error: { status, value: 'No' }, status });
    // A real mutation hook toasts the error before it rejects, which is what lets the picker keep it to itself.
    onMutationError(failure);
    const onConfirm = mock(() => Promise.reject(failure));
    const { input, clickCreate, onOpenChange } = await openWithName(onConfirm);
    await clickCreate();
    return { tries: onConfirm.mock.calls.length, closes: onOpenChange.mock.calls, name: input.value };
}

test('a folder the server refuses keeps the picker open with the typed name', async () => {
    expect(await createFailingWith(403)).toEqual({ tries: 1, closes: [], name: 'Plans' });
});

test('a name the server refuses keeps the picker open with the typed name', async () => {
    expect(await createFailingWith(422)).toEqual({ tries: 1, closes: [], name: 'Plans' });
});

test('while the create runs its button shows a spinner and ignores another click', async () => {
    let finish = () => {};
    const onConfirm = mock(() => new Promise<void>((resolve) => (finish = resolve)));
    const { create, clickCreate, onOpenChange } = await openWithName(onConfirm);
    await clickCreate();
    expect(create.getAttribute('aria-busy')).toBe('true');
    await clickCreate();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});
