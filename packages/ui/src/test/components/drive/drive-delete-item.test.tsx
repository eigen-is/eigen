// Moving one of your own items to trash asks in a red confirm that names it, and so does one in someone else's drive,
// saying only its owner can restore it. One shared with you directly is removed from your view instead. When Move to trash gets only part of a
// selection through, the dialog stays open, the after-delete step runs for the ones that went, and the failures go to
// the dialog's owner, which narrows it to them.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'user-1', email: 'me@example.com' } };
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

test('one item of your own asks to move it to trash by name', async () => {
    ({ unmount } = await renderInDocument(
        createElement(DriveDeleteItem, { paths: paths.slice(0, 1), open: true, onOpenChange: () => {} }),
    ));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('Move to trash');
    expect(dialog?.querySelector('p')?.innerHTML).toBe(
        'Move <strong>good.txt</strong> to the trash? You can restore it later from the trash.',
    );
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Move to trash');
    expect(confirm?.getAttribute('data-variant')).toBe('destructive');
});

// The dialog's title and its sentence, for the one item it was opened with.
async function askAbout(path: DrivePath) {
    ({ unmount } = await renderInDocument(
        createElement(DriveDeleteItem, { paths: [path], open: true, onOpenChange: () => {} }),
    ));
    const dialog = document.querySelector('[role="dialog"]');
    return [dialog?.querySelector('h2')?.textContent, dialog?.querySelector('p')?.innerHTML];
}

test('one item shared with you asks to remove it from your view', async () => {
    const shared = drivePath({
        id: 'shared',
        name: 'plan.txt',
        mimeType: 'text/plain',
        ownerId: 'user-2',
        acl: [{ id: 'me@example.com', read: true, write: false }],
    });
    expect(await askAbout(shared)).toEqual([
        'Remove shared item',
        'Remove <strong>plan.txt</strong>? This item is shared with you. Removing it only takes away your access, and the owner can share it again.',
    ]);
});

test('one item in someone else’s drive says it goes to their trash', async () => {
    const theirs = drivePath({ id: 'theirs', name: 'plan.txt', mimeType: 'text/plain', ownerId: 'user-2' });
    expect(await askAbout(theirs)).toEqual([
        'Move to trash',
        'Move <strong>plan.txt</strong> to the trash? This item is in someone else’s drive. It goes to their trash, and only they can restore it.',
    ]);
});
