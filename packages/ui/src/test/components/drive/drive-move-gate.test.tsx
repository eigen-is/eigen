// Drive's folder browser offers Move to, and dragging onto a folder, only to someone who holds write on the folder by
// name: its owner, or an entry on it or a folder above it, by email or team. Someone who edits only through "Anyone
// signed in can edit" still edits, renames and uploads there, but is never offered a move.
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

// The folders above the open folder, which a test sets.
let breadcrumb: DrivePath[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: RequestInfo | URL) => {
            const url = input instanceof Request ? input.url : String(input);
            return Response.json(url.includes('/breadcrumb') ? breadcrumb : []);
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
const { useCanWriteByName, useDriveActionsFor } = await import('@workspace/lib/drive');
const { browseCapabilities } = await import('../../../components/drive/drive-capabilities');

beforeEach(() => {
    breadcrumb = [];
});

const doc = drivePath({ id: 'doc', name: 'Plan.eigendoc', type: 'doc', mimeType: DRIVE_MIME_DOC, parentId: 'open' });
// A folder in Alice's drive, with the entries and visibility a test gives it.
const folder = (p: Partial<DrivePath> = {}): DrivePath =>
    drivePath({ id: 'open', name: 'Open', type: 'folder', mimeType: DRIVE_MIME_FOLDER, ownerId: 'alice-1', ...p });

// The rows the browser offers on a document in the folder, once the folders above it have loaded.
async function rowsIn(open: DrivePath): Promise<string[]> {
    const seen: { rows: string[] } = { rows: [] };
    function Harness() {
        const capabilities = browseCapabilities(true, useCanWriteByName(open));
        seen.rows = useDriveActionsFor(capabilities)([doc]).map((action) => action.id);
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => root.unmount());
    return seen.rows;
}

test('someone who edits only through the signed-in link renames, but is not offered Move to', async () => {
    const rows = await rowsIn(folder({ visibility: 'public-write' }));
    expect(rows).toContain('rename');
    expect(rows).not.toContain('move-to');
    expect(browseCapabilities(true, false).canUpload).toBe(true);
});

test('the owner and an editor by name, through a team or through a folder above are offered Move to', async () => {
    const editor = { id: ME.email, read: true, write: true };
    expect(await rowsIn(folder({ ownerId: ME.id }))).toContain('move-to');
    expect(await rowsIn(folder({ visibility: 'public-write', acl: [editor] }))).toContain('move-to');
    const byTeam = { id: teamOwnerId(TEAM_ID), read: true, write: true };
    expect(await rowsIn(folder({ visibility: 'public-write', acl: [byTeam] }))).toContain('move-to');
    const open = folder({ visibility: 'public-write' });
    breadcrumb = [folder({ id: 'projects', name: 'Projects', acl: [editor] }), open];
    expect(await rowsIn(open)).toContain('move-to');
});

test('a reader by name of a folder anyone signed in can edit is not offered Move to', async () => {
    const reader = { id: ME.email, read: true, write: false };
    expect(await rowsIn(folder({ visibility: 'public-write', acl: [reader] }))).not.toContain('move-to');
});
