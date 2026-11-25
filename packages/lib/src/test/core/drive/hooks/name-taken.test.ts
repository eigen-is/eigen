// A create or rename whose name a sibling has already rejects with the server's 409 and toasts nothing, since the
// form that typed the name shows it under the field. Any other failure still toasts.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DrivePath } from '../../../../types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER, served, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const TAKEN = 'A file or folder named "Plans" already exists in this directory';

const notes: DrivePath = {
    id: 'notes',
    name: 'Notes.txt',
    mountId: 'm1',
    type: 'file',
    parentId: 'folder',
    ownerId: OWNER,
    mimeType: 'text/plain',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

beforeEach(() => {
    toasts.length = 0;
});

type Write = 'createFolder' | 'createDoc' | 'rename';

async function attempt(write: Write, status: number, message: string): Promise<unknown> {
    served.status = status;
    served.importResponse = message;
    const { act } = await import('react');
    const { useCreateDriveItem, useCreateFolder, useRenamePath } = await import('../../../../core/drive/hooks/writes');
    const { queryClient } = trackingClient();
    const { latest, unmount } = await renderHook(() => {
        const folder = useCreateFolder();
        const doc = useCreateDriveItem('doc');
        const rename = useRenamePath();
        const target = { ownerId: OWNER, mountId: 'm1', parentId: 'folder' };
        return {
            createFolder: () => folder.mutateAsync({ ...target, folderName: 'Plans' }),
            createDoc: () => doc.mutateAsync({ ...target, fileName: 'Plans' }),
            rename: () => rename.mutateAsync({ path: notes, newName: 'Plans' }),
        };
    }, queryClient);
    let failure: unknown = null;
    await act(async () => {
        await latest[write]().catch((error: unknown) => {
            failure = error;
        });
    });
    await unmount();
    return failure;
}

describe.each(['createFolder', 'createDoc', 'rename'] as const)('%s', (write) => {
    test('a taken name rejects with the 409 and toasts nothing', async () => {
        const { isNameTaken } = await import('../../../../core/drive/hooks/writes');
        const failure = await attempt(write, 409, TAKEN);
        expect(isNameTaken(failure)).toBe(true);
        expect(failure instanceof Error && failure.message).toBe(TAKEN);
        expect(toasts).toEqual([]);
    });

    test('another refusal toasts the server’s message', async () => {
        await attempt(write, 403, 'No access');
        expect(toasts).toEqual(['error: No access']);
    });
});
