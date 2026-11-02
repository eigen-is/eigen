// A forward's parts ride in history state until a saved draft holds them all. The first save can run while one
// still uploads, so its URL rewrite keeps them, and a reload before the next save attaches them again. A permanent
// delete that fails for some emails keeps the dialog open on exactly those, beside the toasts their failures showed.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { NavigateOptions } from '@tanstack/react-router';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import type { Email } from '@workspace/lib/types/mail';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
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

// The server deletes every message but m2, which fails, and m3, which is already gone.
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method !== 'DELETE' || !url.includes('/message/')) throw new TypeError('A hook test has no network');
        if (url.endsWith('/message/m3')) return new Response('Gone', { status: 404 });
        return url.endsWith('/message/m2') ? new Response('Boom', { status: 500 }) : new Response('{}');
    },
    { preconnect: () => {} },
);

afterAll(() => {
    globalThis.fetch = realFetch;
    mock.module('@tanstack/react-router', () => realRouter);
    mock.module('../../../../routes/_auth.$filterType.$filterId', () => realRoute);
});

const { AuthProvider } = await import('@workspace/lib/auth');
const { useMailActions } = await import('../../../../components/mail/hooks/use-mail-actions');
const { DeleteDialog } = await import('@workspace/ui/components/delete/delete-dialog');

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

function trashed(id: string): Email {
    return {
        id,
        filename: `${id}.eml`,
        subject: id,
        fromShort: 'Alice',
        fromAddress: 'alice@test.eigen.is',
        toShort: 'Bob',
        toAddress: 'bob@test.eigen.is',
        recipientsAll: 'bob@test.eigen.is',
        textShort: '',
        date: new Date('2026-09-15T10:00:00Z'),
        isRead: true,
        isFlagged: false,
        isDraft: false,
        isReplied: false,
        hasAttachments: false,
        mailbox: 'Trash',
        size: 100,
        attachments: [],
        html: null,
    };
}

test('a permanent delete that fails for one email keeps the dialog open on what may succeed, quietly, and drops what was refused', async () => {
    const onOpenChange = mock((_open: boolean) => {});
    const seen: { pending: Email[] } = { pending: [] };
    function Route() {
        const actions = useMailActions();
        const [pending, setPending] = useState([trashed('m3'), trashed('m1'), trashed('m2')]);
        seen.pending = pending;
        return createElement(DeleteDialog, {
            open: true,
            onOpenChange,
            title: 'Delete 3 emails',
            description: 'Are you sure',
            onDelete: () => actions.confirmDeleteEmails(pending, setPending),
        });
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Route))));
    const del = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete');
    if (!del) throw new Error('no Delete button');

    // bun fails a test on an unhandled rejection, which is what a click leaves when the dialog rethrows its error.
    await act(async () => {
        del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(seen.pending.map((e) => e.id)).toEqual(['m2']);
    expect(onOpenChange).not.toHaveBeenCalled();
});
