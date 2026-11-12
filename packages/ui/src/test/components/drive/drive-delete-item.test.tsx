// When Move to trash gets only part of a selection through, the dialog stays open, the after-delete step
// runs for the ones that went, and the failures go to the dialog's owner, which narrows it to them.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'user-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The path ids the delete route was asked for, in order. The server refuses `bad`.
const deleted: string[] = [];
beforeEach(() => {
    deleted.length = 0;
    g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const id = /\/path\/([^/]+)$/.exec(url)?.[1];
        if (!id || init?.method !== 'DELETE') return Response.json([]);
        deleted.push(id);
        if (id === 'bad') return new Response('No access', { status: 403 });
        return Response.json({ success: true });
    };
});

const { act, createElement } = await import('react');
const { DriveDeleteItem } = await import('../../../components/drive/drive-delete-item');

let unmount = async () => {};
afterEach(() => unmount());

const paths = ['good', 'bad', 'other'].map((id) =>
    drivePath({ id, name: `${id}.txt`, mimeType: 'text/plain', ownerId: 'user-1', parentId: 'root' }),
);

async function confirm() {
    const button = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find(
        (b) => b.textContent === 'Move to trash',
    );
    if (!button) throw new Error('no Move to trash button');
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

test('a partial failure hands the failed item to the owner and keeps the dialog open', async () => {
    const after: unknown[] = [];
    const failed: unknown[] = [];
    ({ unmount } = await renderInDocument(
        createElement(DriveDeleteItem, {
            paths,
            open: true,
            onOpenChange: () => {},
            onAfterAction: (_type, data) => after.push(data.id),
            onPartialFailure: (items) => failed.push(...items.map((item) => item.id)),
        }),
    ));
    await confirm();
    expect([deleted, after, failed]).toEqual([['good', 'bad', 'other'], ['good', 'other'], ['bad']]);
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).not.toBeNull();
});
