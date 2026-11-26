import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveAccessCheckResult } from '@workspace/lib/types/drive-access';
import { getServerConfig } from '../../lib/config/server-config';
import {
    addMember,
    app,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const READER = { id: 'reader-by-name@example.com', read: true, write: false };
const OTHER = { id: 'other-by-name@example.com', read: true, write: false };

// Write that comes only from "Anyone signed in can edit" lets a person change the content, never who has access or
// where the item lives.
describe('changing sharing and moving need write held by name', () => {
    let ctx: TestCtx;
    let mountId: string;
    let rootId: string;
    let teamId: string;

    function aliceToken(): string {
        return ctx.alice.user.sessionToken;
    }

    function putACL(token: string, pathId: string, body: object): Promise<Response> {
        return authedRequest(token, `/drive/${ctx.alice.user.id}/${mountId}/path/${pathId}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function move(token: string, pathId: string, targetParentId: string): Promise<Response> {
        return authedRequest(token, `/drive/${ctx.alice.user.id}/${mountId}/path/${pathId}/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetParentId }),
        });
    }

    async function stored(pathId: string): Promise<DrivePath> {
        return driveGet(aliceToken(), ctx.alice.user.id, mountId, `path/${pathId}`);
    }

    // A folder anyone signed in can edit, which one reader holds by name unless the test gives its own list.
    async function openFolder(name: string, parentId = rootId, share: object[] = [READER]): Promise<DrivePath> {
        const made = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${parentId}`, {
            folderName: name,
        });
        const body = { visibility: 'public-write', add: share };
        expect((await putACL(aliceToken(), made.id, body)).status).toBe(200);
        return made;
    }

    // Every kind of change the route takes, each a single request.
    const CHANGES: readonly (readonly [string, (self: string) => object])[] = [
        ['add self as an editor', (self) => ({ add: [{ id: self, read: true, write: true }] })],
        ['add another person', () => ({ add: [OTHER] })],
        ['change a role', () => ({ add: [{ ...READER, write: true }] })],
        ['remove a person', () => ({ remove: [READER.id] })],
        ['set private', () => ({ visibility: 'private' })],
        ['set public-read', () => ({ visibility: 'public-read' })],
        ['set a public link', () => ({ visibility: 'link' })],
    ];

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await firstMountId(aliceToken(), ctx.alice.user.id);
        rootId = (await driveGet(aliceToken(), ctx.alice.user.id, mountId, 'root')).id;
        const config = getServerConfig();
        if (!config) throw new Error('setup not completed');
        await authedRequest(aliceToken(), '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: config.orgId }),
        });
        teamId = await createTeam(ctx, config.orgId, `By Name Team ${crypto.randomUUID()}`);
        await addMember(ctx, teamId, ctx.charlie.user.id);
    });

    describe('a signed-in non-member of an item anyone can edit', () => {
        for (const [what, body] of CHANGES) {
            test(`is refused: ${what}`, async () => {
                const open = await openFolder(`Refused ${what}`);
                const res = await putACL(ctx.bob.user.sessionToken, open.id, body(ctx.bob.user.email));
                expect(res.status).toBe(403);
                const after = await stored(open.id);
                expect(after.visibility).toBe('public-write');
                expect(after.acl).toEqual([READER]);
            });
        }

        test('cannot add themselves and then turn on a link, and the item stays closed to a visitor', async () => {
            const open = await openFolder('Two Steps');
            const self = { id: ctx.bob.user.email, read: true, write: true };
            expect((await putACL(ctx.bob.user.sessionToken, open.id, { add: [self] })).status).toBe(403);
            expect((await putACL(ctx.bob.user.sessionToken, open.id, { visibility: 'link' })).status).toBe(403);
            expect((await stored(open.id)).visibility).toBe('public-write');
            const visit = await app.handle(
                new Request(`http://localhost/drive/${ctx.alice.user.id}/${mountId}/path/${open.id}`),
            );
            expect(visit.status).toBe(403);
        });

        test('cannot close a link on an item below one anyone can edit', async () => {
            const open = await openFolder('Anyone Edits Above');
            const linked = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${open.id}`, {
                folderName: 'Linked Below',
            });
            expect((await putACL(aliceToken(), linked.id, { visibility: 'link' })).status).toBe(200);
            expect((await putACL(ctx.bob.user.sessionToken, linked.id, { visibility: 'private' })).status).toBe(403);
            expect((await stored(linked.id)).visibility).toBe('link');
        });

        test('is told it may not share, and cannot invite to a chat', async () => {
            const open = await openFolder('Chat Inside');
            const chat = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${open.id}/create/chat`, {
                fileName: 'open-room',
            });
            const check = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${open.id}/access-check`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ emails: [OTHER.id] }),
                },
            );
            expect((await assertJson<DriveAccessCheckResult>(check)).canShare).toBe(false);
            const invite = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${chat.id}/invite`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: OTHER.id }),
                },
            );
            expect(invite.status).toBe(403);
            expect((await stored(chat.id)).acl).toBeNull();
        });

        test('still edits the content', async () => {
            const open = await openFolder('Still Edits');
            const made = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/folder/${open.id}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'Bob Was Here' }),
                },
            );
            const child = await assertJson<DrivePath>(made);
            const renamed = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${child.id}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'Bob Renamed' }),
                },
            );
            expect(renamed.status).toBe(200);
            expect((await stored(child.id)).name).toBe('Bob Renamed');
            const uploaded = await driveUpload(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                open.id,
                new File(['bob'], 'bob.txt', { type: 'text/plain' }),
            );
            expect((await stored(uploaded.id)).parentId).toBe(open.id);
        });

        // Moved into a folder he holds by name, the item would be his to share, so the move is sharing too.
        test('cannot move an item into a folder he holds by name, and so cannot publish it', async () => {
            const open = await openFolder('Move Out');
            const item = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${open.id}/create/doc`, {
                fileName: 'kept',
            });
            const mine = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${rootId}`, {
                folderName: 'Bob Holds This',
            });
            await putACL(aliceToken(), mine.id, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });

            const moved = await move(ctx.bob.user.sessionToken, item.id, mine.id);
            expect(moved.status).toBe(403);
            expect((await stored(item.id)).parentId).toBe(open.id);
            expect((await putACL(ctx.bob.user.sessionToken, item.id, { visibility: 'link' })).status).toBe(403);
            const visit = await app.handle(
                new Request(`http://localhost/drive/${ctx.alice.user.id}/${mountId}/path/${item.id}`),
            );
            expect(visit.status).toBe(403);
        });
    });

    describe('an editor by name, through a team, through a folder above, and the owner', () => {
        const editor = (): object => ({ id: ctx.bob.user.email, read: true, write: true });

        async function sharers(label: string): Promise<(readonly [string, DrivePath])[]> {
            const named = await openFolder(`${label} Named`, rootId, [READER, editor()]);
            const byTeam = await openFolder(`${label} Team`, rootId, [
                READER,
                { id: teamOwnerId(teamId), read: true, write: true },
            ]);
            const above = await openFolder(`${label} Above`, rootId, [editor()]);
            const below = await openFolder(`${label} Below`, above.id);
            const owned = await openFolder(`${label} Owned`);
            return [
                [ctx.bob.user.sessionToken, named],
                [ctx.charlie.user.sessionToken, byTeam],
                [ctx.bob.user.sessionToken, below],
                [aliceToken(), owned],
            ];
        }

        for (const [what, body] of CHANGES.slice(1)) {
            test(`may ${what}`, async () => {
                for (const [token, path] of await sharers(what)) {
                    const before = await stored(path.id);
                    expect((await putACL(token, path.id, body(''))).status).toBe(200);
                    const after = await stored(path.id);
                    expect([after.visibility, after.acl]).not.toEqual([before.visibility, before.acl]);
                }
            });
        }

        test('may move an item out', async () => {
            const target = await openFolder('By Name Move Target');
            for (const [token, path] of await sharers('Moves')) {
                const item = await drivePost(aliceToken(), ctx.alice.user.id, mountId, `folder/${path.id}/create/doc`, {
                    fileName: path.name,
                });
                expect((await move(token, item.id, target.id)).status).toBe(200);
                expect((await stored(item.id)).parentId).toBe(target.id);
            }
        });

        test('is refused once the owner restricts sharing, unless it is the owner', async () => {
            const restricted = await openFolder('Restricted', rootId, [READER, editor()]);
            expect((await putACL(aliceToken(), restricted.id, { sharingRestricted: true })).status).toBe(200);
            const res = await putACL(ctx.bob.user.sessionToken, restricted.id, { add: [OTHER] });
            expect(res.status).toBe(403);
            expect(await res.text()).toBe('Sharing is restricted by the owner');
            expect((await putACL(aliceToken(), restricted.id, { add: [OTHER] })).status).toBe(200);
        });
    });
});
