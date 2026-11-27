// Drive's folder browser offers Move to, Share and Email collaborators on an item only to someone who holds write on
// that item by name: its owner, or an entry on it or a folder above it, by email or team. Someone who edits only
// through "Anyone signed in can edit" still edits, renames and uploads there, but is offered none of them.
import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const ME = { id: 'bob-1', email: 'bob@example.com' };
const TEAM_ID = 'abcdef0123456789abcdef0123456789';

// The open folder's chain, itself last, which a test sets. Until `chainLoads` resolves the request hangs.
let breadcrumb: DrivePath[] = [];
let chainLoads: Promise<void> = Promise.resolve();
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: RequestInfo | URL) => {
            const url = input instanceof Request ? input.url : String(input);
            if (!url.includes('/breadcrumb')) return Response.json([]);
            await chainLoads;
            return Response.json(breadcrumb);
        },
        { preconnect: fetch.preconnect },
    ),
);

const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: ME }),
    useIsGuest: () => false,
}));
const realHome = { ...(await import('@workspace/lib/home')) };
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: [{ id: TEAM_ID }] }) }));
afterAll(() => {
    fetchSpy.mockRestore();
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/home', () => realHome);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { useDriveActionsFor, useWritesByName } = await import('@workspace/lib/drive');
const { browseCapabilities } = await import('../../../components/drive/drive-capabilities');

beforeEach(() => {
    breadcrumb = [];
    chainLoads = Promise.resolve();
});

const editor = { id: ME.email, read: true, write: true };
// A document in the open folder that others can open, so it has collaborators to mail.
const doc = (p: Partial<DrivePath> = {}): DrivePath =>
    drivePath({
        id: 'doc',
        name: 'Plan.eigendoc',
        type: 'doc',
        mimeType: DRIVE_MIME_DOC,
        parentId: 'open',
        ownerId: 'alice-1',
        visibility: 'public-write',
        ...p,
    });
const BY_NAME = ['move-to', 'share', 'email-collaborators'];
// A folder in Alice's drive, with the entries and visibility a test gives it.
const folder = (p: Partial<DrivePath> = {}): DrivePath =>
    drivePath({ id: 'open', name: 'Open', type: 'folder', mimeType: DRIVE_MIME_FOLDER, ownerId: 'alice-1', ...p });

// The by-name rows the browser offers on each selection in the open folder: on the first render, before any request
// answers, and once the folder's chain has loaded.
async function rowsIn(
    open: DrivePath,
    selections: readonly (readonly DrivePath[])[],
): Promise<{ first: string[][]; loaded: string[][] }> {
    const seen: { first?: string[][]; rows: string[][] } = { rows: [] };
    function Harness() {
        const capabilities = browseCapabilities(true, useWritesByName(open.ownerId, open.mountId, open.id));
        const actionsFor = useDriveActionsFor(capabilities);
        seen.rows = selections.map((items) =>
            actionsFor(items)
                .map((action) => action.id)
                .filter((id) => BY_NAME.includes(id)),
        );
        seen.first ??= seen.rows;
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => root.unmount());
    return { first: seen.first ?? [], loaded: seen.rows };
}

test('in a folder edited through the link, only the item that names the user offers the rows', async () => {
    const open = folder({ visibility: 'public-write' });
    breadcrumb = [open];
    const mine = doc({ id: 'mine', acl: [editor] });
    const neighbour = doc({ id: 'neighbour' });
    const { loaded } = await rowsIn(open, [[mine], [neighbour]]);
    expect(loaded).toEqual([BY_NAME, []]);
});

test('a folder held by name, through an entry, a team or a folder above, offers the rows on every item', async () => {
    const items = [doc({ id: 'a' }), doc({ id: 'b' })].map((item) => [item]);
    const byTeam = { id: teamOwnerId(TEAM_ID), read: true, write: true };
    for (const chain of [
        [folder({ visibility: 'public-write', acl: [editor] })],
        [folder({ visibility: 'public-write', acl: [byTeam] })],
        [folder({ id: 'projects', name: 'Projects', acl: [editor] }), folder({ visibility: 'public-write' })],
    ]) {
        breadcrumb = chain;
        const open = chain[chain.length - 1];
        expect((await rowsIn(open, items)).loaded).toEqual([BY_NAME, BY_NAME]);
    }
});

test('a selection with an item not held by name is not offered Move', async () => {
    const open = folder({ visibility: 'public-write' });
    breadcrumb = [open];
    const mine = doc({ id: 'mine', acl: [editor] });
    const alsoMine = doc({ id: 'also-mine', acl: [editor] });
    const neighbour = doc({ id: 'neighbour' });
    const { loaded } = await rowsIn(open, [
        [mine, neighbour],
        [mine, alsoMine],
    ]);
    expect(loaded).toEqual([[], ['move-to']]);
});

test('the owner is offered the rows before the folder chain loads', async () => {
    const open = folder({ ownerId: ME.id });
    let load = () => {};
    chainLoads = new Promise((resolve) => {
        load = resolve;
    });
    const { first } = await rowsIn(open, [[doc({ ownerId: ME.id })]]);
    load();
    expect(first).toEqual([BY_NAME]);
});

test('a reader by name of a folder anyone signed in can edit is not offered the rows', async () => {
    const open = folder({ visibility: 'public-write', acl: [{ id: ME.email, read: true, write: false }] });
    breadcrumb = [open];
    expect((await rowsIn(open, [[doc()]])).loaded).toEqual([[]]);
});

test('an item whose owner keeps sharing to themselves is offered Move only to its owner', async () => {
    const open = folder({ acl: [editor] });
    breadcrumb = [open];
    const restricted = doc({ sharingRestricted: true });
    const { loaded } = await rowsIn(open, [[restricted], [restricted, doc({ id: 'free' })]]);
    expect(loaded).toEqual([['share', 'email-collaborators'], []]);

    const teamOpen = folder({ ownerId: teamOwnerId(TEAM_ID) });
    breadcrumb = [teamOpen];
    const own = [[doc({ ownerId: teamOwnerId(TEAM_ID), sharingRestricted: true })]];
    expect((await rowsIn(teamOpen, own)).loaded).toEqual([BY_NAME]);
});
