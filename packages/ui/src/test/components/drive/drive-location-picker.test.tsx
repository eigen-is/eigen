// A location picker whose create or save fails stays open with the typed name, even when the server refused it: a
// read-only folder (403) or a name it won't take (422) is fixed by picking another folder or editing the name, which
// a closed dialog would throw away. Only a yes/no ConfirmDialog closes on a refusal (confirm-dialog.test.tsx). Esc with
// a typed name asks before it drops the name, and a picker with nothing typed closes at once.
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

async function open(mode: 'create' | 'folder', onConfirm: () => Promise<void> = async () => {}) {
    const onOpenChange = mock((_open: boolean) => {});
    ({ unmount } = await renderInDocument(
        createElement(DriveLocationPicker, {
            open: true,
            onOpenChange,
            mode,
            title: 'New folder',
            confirmLabel: 'Create',
            onConfirm,
            defaultFolderId: 'folder',
        }),
    ));
    return onOpenChange;
}

// Opens the New folder picker and types a name, as a keystroke does.
async function openWithName(onConfirm: () => Promise<void>) {
    const onOpenChange = await open('create', onConfirm);
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

const pressEscape = () =>
    act(async () => {
        document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
const titles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((title) => title.textContent);

test('Esc with a typed name asks before it drops the name, and Cancel drops it at once', async () => {
    const { onOpenChange } = await openWithName(async () => {});
    await pressEscape();
    expect(titles()).toEqual(['New folder', 'Discard changes?']);
    expect(onOpenChange).not.toHaveBeenCalled();
    await pressEscape();
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel');
    await act(async () => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(titles()).toEqual(['New folder']);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('a picker with no name typed closes on Esc at once', async () => {
    for (const mode of ['create', 'folder'] as const) {
        const onOpenChange = await open(mode);
        await pressEscape();
        expect(onOpenChange.mock.calls).toEqual([[false]]);
        await unmount();
    }
});
