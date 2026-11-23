import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath, DrivePathType } from '@workspace/lib/types/drive';
import type { DriveVisibility } from '@workspace/lib/types/drive-access';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { canReadByLink } from '../../lib/drive/acl';
import { getHome } from '../../lib/home';
import {
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
        expect(canReadByLink(chainOf({ type: 'folder' }, { type: 'file', ...LINK }), true)).toBe(2);
    });

    test('a descendant answers the index of the public folder', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder' }, { type: 'file' });
        expect(canReadByLink(chain, true)).toBe(1);
    });

    test('a private subfolder under a public folder is admitted', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder', visibility: 'private' });
        expect(canReadByLink(chain, true)).toBe(1);
    });

    test('the highest public path wins', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'folder', ...LINK }, { type: 'file' });
        expect(canReadByLink(chain, true)).toBe(1);
    });

    test('a sibling and the parent of a public path are refused', () => {
        // Neither chain reaches the public path, so neither holds a link.
        expect(canReadByLink(chainOf({ type: 'folder' }, { type: 'file' }), true)).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder' }), true)).toBeNull();
    });

    test('signed-in visibility is not a link', () => {
        expect(canReadByLink(chainOf({ type: 'file', visibility: 'public-read' }), true)).toBeNull();
        expect(canReadByLink(chainOf({ type: 'file', visibility: 'public-write' }), true)).toBeNull();
    });

    test('anything trashed in the chain refuses', () => {
        expect(canReadByLink(chainOf({ type: 'file', ...LINK, trashed: true }), true)).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', trashed: true }, { type: 'file', ...LINK }), true)).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type: 'file', trashed: true }), true)).toBeNull();
    });

    test('the switch off refuses', () => {
        expect(canReadByLink(chainOf({ type: 'file', ...LINK }), false)).toBeNull();
    });

    test('a folder, a file and every collab document are admitted, as the public path and below it', () => {
        for (const type of ['folder', 'file', ...COLLAB_TYPES] as const) {
            expect(canReadByLink(chainOf({ type, ...LINK }), true)).toBe(1);
            expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type }), true)).toBe(1);
        }
    });

    test('a chat is refused, as the public path and below it', () => {
        expect(canReadByLink(chainOf({ type: 'chat', ...LINK }), true)).toBeNull();
        expect(canReadByLink(chainOf({ type: 'folder', ...LINK }, { type: 'chat' }), true)).toBeNull();
    });

    test('nothing goes on below a file', () => {
        const chain = chainOf({ type: 'folder', ...LINK }, { type: 'file' }, { type: 'file' });
        expect(canReadByLink(chain, true)).toBeNull();
    });

    describe('inside a collab document', () => {
        for (const document of COLLAB_TYPES) {
            test(`${document}: its media/ folder and a file in it are admitted`, () => {
                const open = { type: document, ...LINK };
                expect(canReadByLink(chainOf(open, { type: 'folder', name: 'media' }), true)).toBe(1);
                expect(canReadByLink(chainOf(open, { type: 'folder', name: 'media' }, { type: 'file' }), true)).toBe(1);
            });
        }

        test('media/ of a document under a public folder is admitted', () => {
            const chain = chainOf({ type: 'folder', ...LINK }, { type: 'doc' }, { type: 'folder', name: 'media' });
            expect(canReadByLink(chain, true)).toBe(1);
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
            for (const chain of refused) expect(canReadByLink(chain, true)).toBeNull();
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

    function putVisibility(token: string, pathId: string, visibility: DriveVisibility): Promise<Response> {
        return authedRequest(token, `/drive/${ctx.alice.user.id}/${mountId}/path/${pathId}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visibility }),
        });
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

    afterAll(async () => {
        await withPublicLinks(false);
    });

    test('public links are off by default', () => {
        expect(getServerSettings().sharing.publicLinks).toBe(false);
    });

    test('while public links are off a save answers 403 and keeps the value', async () => {
        const res = await alicePuts(file.id, 'link');
        expect(res.status).toBe(403);
        const stored = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${file.id}`);
        expect(stored.visibility).toBe('private');
    });

    test('on a demo server a save answers 403 with public links on', async () => {
        await withPublicLinks(true);
        process.env['EIGEN_DEMO'] = '1';
        try {
            expect((await alicePuts(file.id, 'link')).status).toBe(403);
        } finally {
            delete process.env['EIGEN_DEMO'];
            await withPublicLinks(false);
        }
    });

    describe('with public links on', () => {
        beforeAll(async () => {
            await withPublicLinks(true);
        });

        afterAll(async () => {
            await withPublicLinks(false);
        });

        test('a chat answers 400', async () => {
            expect((await alicePuts(chat.id, 'link')).status).toBe(400);
        });

        test('a path inside a document answers 400', async () => {
            expect((await alicePuts(docChatFolder.id, 'link')).status).toBe(400);
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

        test('the stored chain of a child admits it under the public folder', async () => {
            const home = await getHome(ctx.alice.user.id);
            const chain = await home.drive.breadCrumb(mountId, child.id);
            expect(chain[canReadByLink(chain, true) ?? -1]?.id).toBe(folder.id);
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
});
