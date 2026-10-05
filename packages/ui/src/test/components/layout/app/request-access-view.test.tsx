// The server refuses an access request from a guest, so the view must not offer one: a guest is told to ask
// the owner to share instead.
import { expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

let isGuest = false;
mock.module('@workspace/lib/auth', () => ({
    useAuth: () => ({ user: { email: 'visitor@example.com' } }),
    useIsGuest: () => isGuest,
}));
const realDrive = await import('@workspace/lib/drive');
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRequestAccess: () => ({ mutate: () => {}, isPending: false, isSuccess: false }),
}));
const realPublic = await import('@workspace/lib/public');
mock.module('@workspace/lib/public', () => ({ ...realPublic, usePublicUser: () => ({ data: { name: 'Olivia' } }) }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RequestAccessView } = await import('../../../../components/layout/app/request-access-view');

async function render(guest: boolean): Promise<{ text: string; buttons: string[] }> {
    isGuest = guest;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(RequestAccessView, { ownerId: 'owner-1', mountId: 'default', pathId: 'path-1' }),
            ),
        );
    });
    const text = container.textContent ?? '';
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '');
    await act(async () => root.unmount());
    container.remove();
    return { text, buttons };
}

test('a signed-in user is offered Request access', async () => {
    const { buttons } = await render(false);
    expect(buttons).toEqual(['Add a message', 'Request access']);
});

test('a guest is told to ask the owner to share, with nothing to request', async () => {
    const { text, buttons } = await render(true);
    expect(buttons).toEqual([]);
    expect(text).toContain('Ask the owner to share it with you');
});
