// A location picker whose create or save fails stays open with the typed name, even when the server refused it: a
// read-only folder (403) or a name it won't take (422) is fixed by picking another folder or editing the name, which
// a closed dialog would throw away. Only a yes/no ConfirmDialog closes on a refusal (confirm-dialog.test.tsx).
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));

const { act, createElement } = await import('react');
const { AppError } = await import('@workspace/lib/api-error');
const { DriveLocationPicker } = await import('../../../components/drive/drive-location-picker');

let unmount = async () => {};
afterEach(() => unmount());

async function createFailingWith(status: number) {
    const onOpenChange = mock((_open: boolean) => {});
    const onConfirm = () => Promise.reject(new AppError({ error: { status, value: 'No' }, status }));
    ({ unmount } = await renderInDocument(
        createElement(DriveLocationPicker, { open: true, onOpenChange, mode: 'create', onConfirm }),
    ));
    const input = document.querySelector('#picker-name');
    if (!(input instanceof HTMLInputElement)) throw new Error('no name input');
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Plans');
    await act(async () => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Create');
    if (!create) throw new Error('no create button');
    await act(async () => {
        create.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return { closes: onOpenChange.mock.calls, name: input.value };
}

test('a folder the server refuses keeps the picker open with the typed name', async () => {
    expect(await createFailingWith(403)).toEqual({ closes: [], name: 'Plans' });
});

test('a name the server refuses keeps the picker open with the typed name', async () => {
    expect(await createFailingWith(422)).toEqual({ closes: [], name: 'Plans' });
});
