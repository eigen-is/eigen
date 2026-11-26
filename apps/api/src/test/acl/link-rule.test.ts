import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath, DrivePathType } from '@workspace/lib/types/drive';
import type { DriveAccessCheckResult, DriveVisibility } from '@workspace/lib/types/drive-access';
import { arePublicLinksEnabled, getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { canReadByLink } from '../../lib/drive/acl';
import { getHome } from '../../lib/home';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetList,
    driveGetPermission,
    drivePost,
    driveUpload,
    findOrFail,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

type Crumb = { type: DrivePathType; name?: string; visibility?: DriveVisibility; trashed?: boolean };

// A root-first chain as a breadcrumb holds it, the mount's root first.
function chainOf(...crumbs: Crumb[]): DrivePath[] {
    const root: Crumb = { type: 'folder', name: '' };
    let parentId: string | null = null;
    return [root, ...crumbs].map((crumb, i) => {
        const path: DrivePath = {
            id: `p${i}`,
            mountId: 'default',
            name: crumb.name ?? `item${i}`,
            type: crumb.type,
            parentId,
            ownerId: 'owner',
            mimeType: '',
            size: 0,
            hash: null,
            thumbnail: null,
            acl: null,
            visibility: crumb.visibility ?? 'private',
            sharingRestricted: false,
            details: null,
            trashedAt: crumb.trashed ? new Date() : null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        parentId = path.id;
        return path;
    });
}

const LINK = { visibility: 'link' } as const;
const COLLAB_TYPES = ['doc', 'stickies', 'slides', 'sheets', 'vector'] as const;

describe('canReadByLink', () => {
    test('the public path itself answers its own index', () => {
        expect(canReadByLink(chainOf({ type: 'folder' }, { type: 'file', ...LINK }))).toBe(2);
    });

    test('a descendant answers the index of the public folder', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder' }, { type: 'file' });
        expect(canReadByLink(chain)).toBe(1);
    });

    test('a private subfolder under a public folder is admitted', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder', visibility: 'private' });
        expect(canReadByLink(chain)).toBe(1);
    });

    test('the highest public path wins', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder', ...LINK }, { type: 'file' });
        expect(canReadByLink(chain)).toBe(1);
    });

    test('a sibling and the parent of a public path are refused', () => {
        // Neither chain reaches the public path, so neither holds a link.
        expect(canReadByLink(chainOf({ type: 'folder' }, { type: 'file' }))).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder' }))).toBeNull();
    });

    test('signed-in visibility is not a link', () => {
        expect(canReadByLink(chainOf({ type: 'file', visibility: 'public-read' }))).toBeNull();
        expect(canReadByLink(chainOf({ type: 'file', visibility: 'public-write' }))).toBeNull();
    });

    test('anything trashed in the chain refuses', () => {
        expect(canReadByLink(chainOf({ type: 'file', ...LINK, trashed: true }))).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', trashed: true }, { type: 'file', ...LINK }))).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type: 'file', trashed: true }))).toBeNull();
    });

    test('a folder, a file and every collab document are admitted, as the public path and below it', () => {
        for (const type of ['folder', 'file', ...COLLAB_TYPES] as const) {
            expect(canReadByLink(chainOf({ type, ...LINK }))).toBe(1);
            expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type }))).toBe(1);
        }
    });

    test('a chat is refused, as the public path and below it', () => {
        expect(canReadByLink(chainOf({ type: 'chat', ...LINK }))).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type: 'chat' }))).toBeNull();
    });

    test('nothing goes on below a file', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'file' }, { type: 'file' });
        expect(canReadByLink(chain)).toBeNull();
    });

    test('nothing at all goes on below a file under a public folder', () => {
        for (const type of ['folder', 'file', 'chat', ...COLLAB_TYPES] as const) {
            const chain = chainOf({ type: 'folder', ...LINK }, { type: 'file' }, { type });
            expect(canReadByLink(chain)).toBeNull();
        }
    });

    describe('inside a collab document', () => {
        for (const document of COLLAB_TYPES) {
            test(`${document}: its media/ folder and a file in it are admitted`, () => {
                const open = { type: document, ...LINK };
                expect(canReadByLink(chainOf(open, { type: 'folder', name: 'media' }))).toBe(1);
                expect(canReadByLink(chainOf(open, { type: 'folder', name: 'media' }, { type: 'file' }))).toBe(1);
            });
        }

        test('media/ of a document under a public folder is admitted', () => {
            const chain = chainOf({ type: 'folder', ...LINK }, { type: 'doc' }, { type: 'folder', name: 'media' });
            expect(canReadByLink(chain)).toBe(1);
        });

        test('data.db, comments.db, the chat/ folder, a thread and anything deeper in media/ are refused', () => {
            const doc = { type: 'doc', ...LINK } as const;
            const media = { type: 'folder', name: 'media' } as const;
            const refused = [
                chainOf(doc, { type: 'file', name: 'data.db' }),
                chainOf(doc, { type: 'file', name: 'comments.db' }),
                chainOf(doc, { type: 'folder', name: 'chat' }),
                chainOf(doc, { type: 'folder', name: 'chat' }, { type: 'chat' }),
                chainOf(doc, { type: 'folder', name: 'versions' }),
                chainOf(doc, { type: 'chat' }),
                chainOf(doc, { type: 'doc' }),
                chainOf(doc, media, { type: 'folder' }),
                chainOf(doc, media, { type: 'doc' }),
                chainOf(doc, media, { type: 'chat' }),
                chainOf(doc, media, { type: 'file' }, { type: 'file' }),
            ];
            for (const chain of refused) expect(canReadByLink(chain)).toBeNull();
        });

        test('a link on a part of a private document opens nothing', () => {
            const doc = { type: 'doc' } as const;
            const refused = [
                chainOf(doc, { type: 'file', name: 'data.db', ...LINK }),
                chainOf(doc, { type: 'folder', name: 'chat', ...LINK }),
                chainOf(doc, { type: 'folder', name: 'chat', ...LINK }, { type: 'chat' }),
                chainOf({ type: 'folder' }, doc, { type: 'folder', name: 'versions', ...LINK }, { type: 'file' }),
            ];
            for (const chain of refused) expect(canReadByLink(chain)).toBeNull();
        });

        test("a link on a private document's media/ folder alone opens nothing", () => {
            const media = { type: 'folder', name: 'media', ...LINK } as const;
            expect(canReadByLink(chainOf({ type: 'doc' }, media))).toBeNull();
            expect(canReadByLink(chainOf({ type: 'doc' }, media, { type: 'file' }))).toBeNull();
        });
    });
});

// The value through the ACL route: what saves it, what refuses it, and what a signed-in non-member gets from it.
describe("visibility 'link'", () => {
    let ctx: TestCtx;
    let mountId: string;
    let folder: DrivePath;
    let child: DrivePath;
    let file: DrivePath;
    let doc: DrivePath;
    let chat: DrivePath;
    let docChatFolder: DrivePath;

    function putACL(token: string, pathId: string, body: object): Promise<Response> {
        return authedRequest(token, `/drive/${ctx.alice.user.id}/${mountId}/path/${pathId}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function putVisibility(token: string, pathId: string, visibility: DriveVisibility): Promise<Response> {
        return putACL(token, pathId, { visibility });
    }

    async function storedVisibility(pathId: string): Promise<DriveVisibility> {
        return (await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${pathId}`)).visibility;
    }

    function alicePuts(pathId: string, visibility: DriveVisibility): Promise<Response> {
        return putVisibility(ctx.alice.user.sessionToken, pathId, visibility);
    }

    async function withPublicLinks(on: boolean): Promise<void> {
        await updateServerSettings({ sharing: { publicLinks: on } });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const token = ctx.alice.user.sessionToken;
        const aliceId = ctx.alice.user.id;
        mountId = await firstMountId(token, aliceId);
        const root = await driveGet(token, aliceId, mountId, 'root');
        folder = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Link Folder' });
        child = await drivePost(token, aliceId, mountId, `folder/${folder.id}`, { folderName: 'Private Inside' });
        file = await driveUpload(
            token,
            aliceId,
            mountId,
            root.id,
            new File(['hi'], 'link.txt', { type: 'text/plain' }),
        );
        doc = await drivePost(token, aliceId, mountId, `folder/${root.id}/create/doc`, { fileName: 'Link Doc' });
        chat = await drivePost(token, aliceId, mountId, `folder/${root.id}/create/chat`, { fileName: 'link-room' });
        const docContents = await driveGetList(token, aliceId, mountId, `folder/${doc.id}`);
        docChatFolder = findOrFail(docContents, (p) => p.name === 'chat');
    });

    test('public links are on by default, and never on a demo server', () => {
        expect(getServerSettings().sharing.publicLinks).toBe(true);
        expect(arePublicLinksEnabled()).toBe(true);
        process.env['EIGEN_DEMO'] = '1';
        try {
            expect(arePublicLinksEnabled()).toBe(false);
        } finally {
            delete process.env['EIGEN_DEMO'];
        }
    });

    test('while public links are off a save answers 403 and keeps the value', async () => {
        await withPublicLinks(false);
        try {
            const res = await alicePuts(file.id, 'link');
            expect(res.status).toBe(403);
            expect(await storedVisibility(file.id)).toBe('private');
        } finally {
            await withPublicLinks(true);
        }
    });

    test('on a demo server a save answers 403', async () => {
        process.env['EIGEN_DEMO'] = '1';
        try {
            expect((await alicePuts(file.id, 'link')).status).toBe(403);
        } finally {
            delete process.env['EIGEN_DEMO'];
        }
    });

    describe('with public links on', () => {
        test('a chat answers 400', async () => {
            expect((await alicePuts(chat.id, 'link')).status).toBe(400);
        });

        test('a path inside a document answers 400', async () => {
            expect((await alicePuts(docChatFolder.id, 'link')).status).toBe(400);
        });

        test('a 400 says the item cannot have a public link', async () => {
            for (const path of [chat, docChatFolder]) {
                expect(await (await alicePuts(path.id, 'link')).text()).toBe('This item cannot have a public link');
            }
        });

        test('a file, a folder and a collab document save it', async () => {
            for (const path of [file, folder, doc]) {
                expect((await alicePuts(path.id, 'link')).status).toBe(200);
                const stored = await driveGet(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    `path/${path.id}`,
                );
                expect(stored.visibility).toBe('link');
            }
        });

        test('an editor saves it, unless the owner restricted sharing', async () => {
            const token = ctx.alice.user.sessionToken;
            const aliceId = ctx.alice.user.id;
            const root = await driveGet(token, aliceId, mountId, 'root');
            const shared = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Edited' });
            const editor = { id: ctx.bob.user.email, read: true, write: true };
            expect((await putACL(token, shared.id, { add: [editor] })).status).toBe(200);

            expect((await putVisibility(ctx.bob.user.sessionToken, shared.id, 'link')).status).toBe(200);
            expect(await storedVisibility(shared.id)).toBe('link');

            expect((await putACL(token, shared.id, { visibility: 'private', sharingRestricted: true })).status).toBe(
                200,
            );
            expect((await putVisibility(ctx.bob.user.sessionToken, shared.id, 'link')).status).toBe(403);
            expect(await storedVisibility(shared.id)).toBe('private');
        });

        test('an address without an ACL entry can read a public path', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${file.id}/access-check`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emails: ['stranger-link@example.com'] }),
                },
            );
            const { recipients } = await assertJson<DriveAccessCheckResult>(res);
            expect(recipients.map((r) => r.hasReadAccess)).toEqual([true]);
        });

        test('the stored chain of a child admits it under the public folder', async () => {
            const home = await getHome(ctx.alice.user.id);
            const chain = await home.drive.breadCrumb(mountId, child.id);
            expect(chain[canReadByLink(chain) ?? -1]?.id).toBe(folder.id);
        });

        test('a signed-in non-member reads a public path and what is below it, and cannot write', async () => {
            for (const path of [file, folder, child, doc]) {
                expect(
                    await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, path.id),
                ).toEqual({ canRead: true, canWrite: false });
            }
            const read = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${child.id}`,
            );
            expect(read.status).toBe(200);
            const write = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/folder/${folder.id}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Bob Was Here' }),
                },
            );
            expect(write.status).toBe(403);
            expect((await putVisibility(ctx.bob.user.sessionToken, folder.id, 'private')).status).toBe(403);
        });
    });

    describe('after public links are turned off', () => {
        let kept: DrivePath;
        let other: DrivePath;

        beforeAll(async () => {
            const token = ctx.alice.user.sessionToken;
            const aliceId = ctx.alice.user.id;
            const root = await driveGet(token, aliceId, mountId, 'root');
            kept = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Kept Link' });
            other = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Never Linked' });
            expect((await alicePuts(kept.id, 'link')).status).toBe(200);
            await withPublicLinks(false);
        });

        afterAll(async () => {
            await withPublicLinks(true);
        });

        test('the owner still shares a stored link, with or without sending it again', async () => {
            const reader = { id: ctx.bob.user.email, read: true, write: false };
            const token = ctx.alice.user.sessionToken;
            expect((await putACL(token, kept.id, { add: [reader] })).status).toBe(200);
            expect((await putACL(token, kept.id, { remove: [reader.id], visibility: 'link' })).status).toBe(200);
            expect(await storedVisibility(kept.id)).toBe('link');
        });

        test('another path still cannot get a link', async () => {
            expect((await alicePuts(other.id, 'link')).status).toBe(403);
            expect(await storedVisibility(other.id)).toBe('private');
        });

        test('a stored link is private to a signed-in non-member and to an address without an ACL entry', async () => {
            expect(await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, kept.id)).toEqual({
                canRead: false,
                canWrite: false,
            });
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${kept.id}/access-check`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emails: ['stranger-link@example.com'] }),
                },
            );
            const { recipients } = await assertJson<DriveAccessCheckResult>(res);
            expect(recipients.map((r) => r.hasReadAccess)).toEqual([false]);
        });

        test('a stored link can always be closed', async () => {
            expect((await alicePuts(kept.id, 'private')).status).toBe(200);
            expect(await storedVisibility(kept.id)).toBe('private');
        });
    });
});
