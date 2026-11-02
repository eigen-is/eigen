// A label in the sidebar has an Edit label pencil. A mouse user sees it on hover only, at 80% and at 100% under the
// pointer, and Tab reaches and shows it.
import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { HOVER_REVEALED, revealStates } from '../../keyboard-reach';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const mutation = { mutateAsync: async () => {} };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/contacts', () => ({
    ...realContacts,
    useAddLabel: () => mutation,
    useUpdateLabel: () => mutation,
    useDeleteLabel: () => mutation,
}));
afterAll(() => {
    mock.module('@workspace/lib/contacts', () => realContacts);
});

const { createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { LabelManager } = await import('../../../components/labels/label-manager');

test('the pencil shows on hover only, and Tab reaches and shows it', async () => {
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(LabelManager, { labels: [{ id: 'l1', name: 'Urgent', color: '#ef4444' }] }),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    await renderInDocument(createElement(RouterProvider, { router }));
    const button = document.querySelector('button[aria-label="Edit label"]');
    const wrapper = button?.closest('.editButton');
    if (!button || !wrapper) throw new Error('the label has no pencil');
    expect(revealStates(wrapper, button)).toEqual(HOVER_REVEALED);
});
