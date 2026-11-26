// The waitlist lists its entries alone until one is opened, which then shows beside the list as a detail column. X
// closes it, back on the entry the row pushed, and never rejects the entry: Reject is its own button in the bar.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, where the list and the detail sit side by side.
installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const entry: WaitlistEntry = {
    id: 'w1',
    email: 'ada@example.com',
    notes: 'Keen to try it',
    status: 'pending',
    inviteToken: null,
    inviteExpiresAt: null,
    invitedAt: null,
    registeredAt: null,
    userId: null,
    createdAt: new Date('2026-01-05T14:30:00Z'),
    updatedAt: new Date('2026-01-05T14:30:00Z'),
};
const mutation = () => ({
    mutate: mock((_id: string) => {}),
    mutateAsync: mock(async (_id: string) => {}),
    isPending: false,
});
const reject = mutation();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realAdmin = { ...(await import('@workspace/lib/admin')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
const realSettings = { ...(await import('@workspace/lib/settings')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => session,
    authClient: { organization: { setActive: async () => {} } },
}));
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useSetupStatus: () => ({ data: { setupRequired: false }, isLoading: false, error: null }),
    useMembers: () => ({ data: [{ userId: 'u1', role: 'owner' }], isLoading: false }),
    useIsOrgOwner: () => true,
    useWaitlistEntries: () => ({ data: [entry], isLoading: false }),
    useAcceptWaitlistEntry: mutation,
    useRejectWaitlistEntry: () => reject,
    useResendWaitlistInvite: mutation,
    useDeleteWaitlistEntry: mutation,
}));
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { orgId: 'o1' }, isLoading: false }),
}));
mock.module('@workspace/lib/settings', () => ({ ...realSettings, useServerSettings: () => ({ data: undefined }) }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/settings', () => realSettings);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => reject.mutate.mockClear());

async function open(url: string) {
    const history = createMemoryHistory({ initialEntries: [url] });
    const router = createRouter({ routeTree, history, context: { auth } });
    await router.load();
    const rendered = await renderInDocument(createElement(RouterProvider, { router }));
    unmount = rendered.unmount;
    return {
        search: () => router.state.location.search,
        index: () => history.location.state.__TSR_index,
    };
}

// A row names its person by the account its email resolves to, which no server answers here, so it is found by its
// notes. A click settles once the router has loaded the entry it navigated to.
const click = (element: Element | null | undefined) =>
    act(async () => {
        if (!element) throw new Error('nothing to click');
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

const detailColumn = () => document.querySelector('[data-slot="detail-column"]');
const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`);
const entryRow = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Keen to try it'));

test('with nothing opened the list stands alone, with no detail column', async () => {
    await open('/waitlist');
    expect(entryRow()).toBeDefined();
    expect(detailColumn()).toBeNull();
    expect(document.body.textContent).not.toContain('Select an entry');
});

test('a row opens its entry on a new entry, and X goes back to the list without rejecting it', async () => {
    const page = await open('/waitlist?tab=pending');
    await click(entryRow());
    expect(page.search()).toEqual({ tab: 'pending', entryId: 'w1' });
    expect(page.index()).toBe(1);
    expect(detailColumn()).not.toBeNull();
    await click(button('Close'));
    expect(page.search()).toEqual({ tab: 'pending' });
    expect(page.index()).toBe(0);
    expect(reject.mutate).not.toHaveBeenCalled();
});

test('Reject is its own button, not an X', async () => {
    await open('/waitlist?entryId=w1');
    const rejectButton = button('Reject');
    expect(rejectButton?.querySelector('.lucide-x')).toBeNull();
    await click(rejectButton);
    expect(reject.mutate.mock.calls.map(([id]) => id)).toEqual(['w1']);
});
