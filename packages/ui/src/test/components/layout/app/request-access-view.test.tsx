// Request access keeps the page form contract, less what it opens without: its message box shows only after "Add a
// message", which then takes the focus, and it has no leave guard. The request carries the typed message. The server
// refuses an access request from a guest, so the view offers none: a guest is told to ask the owner to share instead.
import { afterAll, expect, mock, test } from 'bun:test';
import { expectFormContract, type } from '../../../form-contract';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

let isGuest = false;
const requestAccess = mock(async (_body: { message?: string }) => {});
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
// One object per hook, as a mocked hook returns, so nothing that depends on it runs again on every render.
const auth = { user: { email: 'visitor@example.com' } };
const request = { mutateAsync: requestAccess, isSuccess: false };
const owner = { data: { name: 'Olivia' } };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => auth, useIsGuest: () => isGuest }));
mock.module('@workspace/lib/drive', () => ({ ...realDrive, useRequestAccess: () => request }));
mock.module('@workspace/lib/public', () => ({ ...realPublic, usePublicUser: () => owner }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement } = await import('react');
const { RequestAccessView } = await import('../../../../components/layout/app/request-access-view');

const view = () => createElement(RequestAccessView, { ownerId: 'owner-1', mountId: 'default', pathId: 'path-1' });

const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const messageBox = () => {
    const found = document.querySelector('textarea');
    if (!found) throw new Error('no message box');
    return found;
};
async function addMessage(text: string) {
    await act(async () => button('Add a message').click());
    await type('Message', text);
}

test('Request access keeps the page form contract', async () => {
    isGuest = false;
    await expectFormContract({
        kind: 'page',
        render: view,
        submitLabel: 'Request access',
        firstField: 'Message',
        onSubmit: requestAccess,
        makeChanged: () => addMessage('I need this for the review'),
        noDraft: true,
        except: { focus: 'the page opens on its button; the message box shows, focused, only after Add a message' },
    });
});

test('Add a message shows the box with the focus in it, and the request carries what was typed', async () => {
    isGuest = false;
    requestAccess.mockClear();
    const { unmount } = await renderInDocument(view());
    await addMessage('I need this for the review');
    expect(document.activeElement === messageBox()).toBe(true);
    await act(async () => button('Request access').click());
    expect(requestAccess.mock.calls).toEqual([[{ message: 'I need this for the review' }]]);
    await unmount();
});

test('a guest is told to ask the owner to share, with nothing to request', async () => {
    isGuest = true;
    const { container, unmount } = await renderInDocument(view());
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('Ask the owner to share it with you');
    await unmount();
});
