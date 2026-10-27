// A forward's parts ride in history state until a saved draft holds them all. The first save can run while one
// still uploads, so its URL rewrite keeps them, and a reload before the next save attaches them again.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { NavigateOptions } from '@tanstack/react-router';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const realRouter = await import('@tanstack/react-router');
const realRoute = await import('../../../../routes/_auth.$filterType.$filterId');

const navigations: NavigateOptions[] = [];
const navigate = async (options: NavigateOptions) => {
    navigations.push(options);
};
mock.module('@tanstack/react-router', () => ({ ...realRouter, useNavigate: () => navigate }));
const params = { filterType: 'mailbox', filterId: 'INBOX' };
mock.module('../../../../routes/_auth.$filterType.$filterId', () => ({
    ...realRoute,
    Route: { fullPath: realRoute.Route.fullPath, useParams: () => params },
}));

afterAll(() => {
    mock.module('@tanstack/react-router', () => realRouter);
    mock.module('../../../../routes/_auth.$filterType.$filterId', () => realRoute);
});

const { AuthProvider } = await import('@workspace/lib/auth');
const { useMailActions } = await import('../../../../components/mail/hooks/use-mail-actions');

let unmount = async () => {};
afterEach(() => unmount());

const part: FileSubject = {
    mail: { ownerId: 'u1', messageId: 'm1', index: 0 },
    part: { filename: 'menu.pdf', contentType: 'application/pdf', size: 10 },
    attachment: true,
};

async function renderActions() {
    navigations.length = 0;
    const seen: { actions?: ReturnType<typeof useMailActions> } = {};
    function Probe() {
        seen.actions = useMailActions();
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe))));
    if (!seen.actions) throw new Error('the actions never rendered');
    return seen.actions;
}

test("the first save's URL rewrite keeps the forwarded parts and the compose session", async () => {
    (await renderActions()).handleDraftIdAssigned('draft-1');

    const { state, search } = navigations[0] ?? {};
    expect(typeof search === 'function' ? search({}) : search).toEqual({ mailId: 'draft-1', mode: 'compose' });
    expect(state).toBe(true);
});

test('a saved draft that holds the forwarded parts drops them and keeps the compose session', async () => {
    (await renderActions()).handleForwardedPartsSaved();

    const { state, search } = navigations[0] ?? {};
    expect(search).toBe(true);
    if (typeof state !== 'function') throw new Error('the rewrite must update the history state, not replace it');
    const after = state({ __TSR_index: 0, forwardedParts: [part], composeSessionKey: 'session-1' });
    expect(after.forwardedParts).toBeUndefined();
    expect(after.composeSessionKey).toBe('session-1');
});
