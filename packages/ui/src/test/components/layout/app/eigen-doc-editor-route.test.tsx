// Every editor route renders its editor inside the document's media resolver, so the editor's own hooks, such as its
// comment lifecycle, read the document's media and chat folders. Another document remounts the editor. A visitor without
// a login gets the editor without the share dialog beside it.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import { drivePath } from '../../../drive-path';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

let pathId = 'board-1';
const route = () => {
    const path = drivePath({ id: pathId, name: 'Board', type: 'stickies', mimeType: DRIVE_MIME_STICKIES });
    return {
        docInfo: { canRead: true, canWrite: true, path, folderContents: null },
        isError: false,
        error: null,
        refetch: () => {},
        path,
        mediaFolderId: `media-of-${pathId}`,
        chatFolderId: `chat-of-${pathId}`,
        accessDialogOpen: false,
        openAccessDialog: () => {},
        setAccessDialogOpen: () => {},
    };
};

const session: { user: { id: string } | null } = { user: { id: 'owner-1' } };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
const realRoute = { ...(await import('../../../../hooks/use-eigen-doc-editor-route')) };
const realAccessDialog = { ...(await import('../../../../components/drive/drive-access-dialog')) };
mock.module('../../../../hooks/use-eigen-doc-editor-route', () => ({ useEigenDocEditorRoute: route }));
let accessDialogs = 0;
mock.module('../../../../components/drive/drive-access-dialog', () => ({
    DriveAccessDialog: () => {
        accessDialogs++;
        return null;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../../hooks/use-eigen-doc-editor-route', () => realRoute);
    mock.module('../../../../components/drive/drive-access-dialog', () => realAccessDialog);
});

// Requests never answer, so nothing a folder lookup fetches changes what the test reads.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => fetchSpy.mockRestore());

const { act, createElement, useEffect, useState } = await import('react');
const { useMediaResolver } = await import('@workspace/lib/drive');
const { EigenDocEditorRoute } = await import('../../../../components/layout/app/eigen-doc-editor-route');

const seen: { mediaFolderId?: string | null; mounts: number } = { mounts: 0 };
function Editor() {
    seen.mediaFolderId = useMediaResolver().mediaFolderId;
    useEffect(() => {
        seen.mounts++;
    }, []);
    return null;
}

let rerender = (_pathId: string) => {};
function Route() {
    const [id, setId] = useState(pathId);
    rerender = (next) => {
        pathId = next;
        setId(next);
    };
    return createElement(EigenDocEditorRoute, {
        ownerId: 'owner-1',
        mountId: 'default',
        pathId: id,
        children: () => createElement(Editor),
    });
}

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    session.user = { id: 'owner-1' };
    accessDialogs = 0;
});

test("the editor reads the document's media folder, and another document remounts it", async () => {
    ({ unmount } = await renderInDocument(createElement(Route)));
    expect(seen.mediaFolderId).toBe('media-of-board-1');
    expect(seen.mounts).toBe(1);

    await act(async () => rerender('board-2'));
    expect(seen.mediaFolderId).toBe('media-of-board-2');
    expect(seen.mounts).toBe(2);
});

test('a signed-in viewer gets the share dialog beside the editor, and a visitor does not', async () => {
    ({ unmount } = await renderInDocument(createElement(Route)));
    expect(accessDialogs).toBeGreaterThan(0);
    await unmount();

    session.user = null;
    accessDialogs = 0;
    const mountsBefore = seen.mounts;
    ({ unmount } = await renderInDocument(createElement(Route)));
    expect(seen.mounts).toBe(mountsBefore + 1);
    expect(accessDialogs).toBe(0);
});
