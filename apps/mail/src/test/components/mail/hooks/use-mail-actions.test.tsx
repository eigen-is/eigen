// A forward's parts ride in history state only until its first save, which embeds them, so a reload of
// the saved draft finds no parts to attach a second time.
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

test("the first save's URL rewrite drops the forwarded parts and keeps the compose session", async () => {
    const seen: { actions?: ReturnType<typeof useMailActions> } = {};
    function Probe() {
        seen.actions = useMailActions();
        return null;
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Probe))));
    seen.actions?.handleDraftIdAssigned('draft-1');

    const { state, search } = navigations[0] ?? {};
    expect(typeof search === 'function' ? search({}) : search).toEqual({ mailId: 'draft-1', mode: 'compose' });
    if (typeof state !== 'function') throw new Error('the rewrite must update the history state, not replace it');
    const after = state({ __TSR_index: 0, forwardedParts: [part], composeSessionKey: 'session-1' });
    expect(after.forwardedParts).toBeUndefined();
    expect(after.composeSessionKey).toBe('session-1');
});
