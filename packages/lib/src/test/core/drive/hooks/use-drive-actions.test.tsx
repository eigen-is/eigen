// The Drive actions a viewer is offered. A visitor, who opened a public link without a login, only reads, so of every
// row the catalog would approve only Open stays; a signed-in reader of the same items keeps the rows reading allows,
// and a guest loses only the rows a guest is denied.
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { DrivePath } from '../../../../types/drive';
import { DRIVE_MIME_DOC, DRIVE_MIME_FOLDER } from '../../../../types/drive';
import type { DriveCapabilities } from '../../../../types/drive-view';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

const session: { user: { id: string; email: string; role?: string } | null } = { user: null };
const realAuthContextModule = { ...(await import('../../../../core/auth/auth-context')) };
mock.module('../../../../core/auth/auth-context', () => ({ ...realAuthContextModule, useAuth: () => session }));
// The mail switch and the viewer's teams are server reads that never answer here.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    fetchSpy.mockRestore();
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { useDriveActionsFor } = await import('../../../../core/drive/hooks/use-drive-actions');

const item = (p: Pick<DrivePath, 'id' | 'name' | 'type' | 'mimeType'>): DrivePath => ({
    mountId: 'default',
    parentId: 'folder',
    ownerId: 'alice',
    size: 1,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'link',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...p,
});

const folder = item({ id: 'sub', name: 'Sub', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const note = item({ id: 'note', name: 'note.md', type: 'file', mimeType: 'text/markdown' });
const photo = item({ id: 'photo', name: 'photo.jpg', type: 'file', mimeType: 'image/jpeg' });
const doc = item({ id: 'doc', name: 'Plan.eigendoc', type: 'doc', mimeType: DRIVE_MIME_DOC });

// The most a view could offer, so only the viewer decides what drops out.
const everything: DriveCapabilities = {
    canCreateFolder: true,
    canUpload: true,
    canWrite: true,
    canDelete: true,
    canRename: true,
    canMove: true,
    canShare: true,
    showBreadcrumb: true,
};

async function idsFor(items: DrivePath[]): Promise<string[]> {
    const { latest, unmount } = await renderHook(() => useDriveActionsFor(everything), new QueryClient());
    await unmount();
    return latest(items).map((action) => action.id);
}

test('a visitor is offered Open alone, on anything that opens', async () => {
    session.user = null;
    expect(await idsFor([folder])).toEqual(['open']);
    expect(await idsFor([note])).toEqual(['open']);
    expect(await idsFor([doc])).toEqual(['open']);
});

test('a visitor is offered nothing on a file that does not open, or on a multi-selection', async () => {
    session.user = null;
    expect(await idsFor([photo])).toEqual([]);
    expect(await idsFor([note, photo])).toEqual([]);
});

test('a signed-in user keeps every row the view allows', async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is' };
    expect(await idsFor([note])).toEqual(expect.arrayContaining(['open', 'rename', 'share', 'copy-link', 'trash']));
});

test('a guest keeps every row but those a guest is denied', async () => {
    session.user = { id: 'bob', email: 'bob@test.eigen.is' };
    const member = await idsFor([note]);
    session.user = { id: 'guest', email: 'guest@test.eigen.is', role: 'guest' };
    expect(member).toContain('email-collaborators');
    expect(await idsFor([note])).toEqual(member.filter((id) => id !== 'email-collaborators'));
});
