import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import { updateServerSettings } from '../../lib/config/server-settings';
import {
    app,
    assertJson,
    authedRequest,
    driveDelete,
    driveGet,
    driveGetList,
    drivePost,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// A request with no cookie: a visitor.
function visit(path: string, method = 'GET'): Promise<Response> {
    return app.handle(new Request(`http://localhost${path}`, { method }));
}

const VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nEMAIL:ada@example.com\r\nEND:VCARD\r\n';
const EML = 'From: ada@example.com\r\nTo: bob@example.com\r\nSubject: Hello\r\n\r\nA body.\r\n';
const ICS =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:1@test\r\nDTSTAMP:20260105T100000Z\r\n' +
    'DTSTART:20260105T100000Z\r\nDTEND:20260105T110000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

// The routes that answer without a login, as the app's route table names them, each with the kind of path it reads.
const LINK_ROUTES = [
    { route: '/drive/:ownerId/:mountId/path/:pathId', reads: 'text', bytes: false },
    { route: '/drive/:ownerId/:mountId/folder/:pathId', reads: 'folder', bytes: false },
    { route: '/drive/:ownerId/:mountId/path/:pathId/breadcrumb', reads: 'text', bytes: false },
    { route: '/drive/:ownerId/:mountId/file/:pathId/download', reads: 'text', bytes: true },
    { route: '/drive/:ownerId/:mountId/file/:pathId/embed/:fileName', reads: 'text', bytes: true },
    { route: '/drive/:ownerId/:mountId/file/:pathId/preview', reads: 'image', bytes: true },
    { route: '/drive/:ownerId/:mountId/file/:pathId/text-preview', reads: 'text', bytes: false },
    { route: '/drive/:ownerId/:mountId/file/:pathId/vcard-preview', reads: 'vcard', bytes: false },
    { route: '/drive/:ownerId/:mountId/file/:pathId/eml-preview', reads: 'eml', bytes: false },
    { route: '/drive/:ownerId/:mountId/file/:pathId/ics-preview', reads: 'ics', bytes: false },
    { route: '/drive/:ownerId/:mountId/thumb/:fileName', reads: 'image', bytes: true },
    { route: '/drive/:ownerId/:mountId/path/:pathId/permissions', reads: 'text', bytes: false },
    { route: '/collab/:ownerId/:mountId/:pathId/info', reads: 'doc', bytes: false },
] as const;

// The collab socket answers without a login too. No request here can open one, so its own test file covers it.
const LINK_SOCKET = '/ws/collab/:ownerId/:mountId/:pathId';

type Reads = (typeof LINK_ROUTES)[number]['reads'];

// The two link routes that answer what a visitor may do, so they refuse with a 200 that says no.
const PERMISSIONS_ROUTE = LINK_ROUTES[11].route;
const INFO_ROUTE = LINK_ROUTES[12].route;

async function expectRefused(route: string, res: Response): Promise<void> {
    if (route === PERMISSIONS_ROUTE) {
        expect(await assertJson(res)).toEqual({ canRead: false, canWrite: false });
    } else if (route === INFO_ROUTE) {
        expect(await assertJson(res)).toEqual({ canRead: false, canWrite: false, path: null, folderContents: null });
    } else {
        expect(res.status).toBe(403);
    }
}

// Routes that answer without a login by design: the public surface, first-run setup, the guest's code, what the
// server's own mail and proxy call, better-auth's mount and the app's own two.
const OPEN_BY_DESIGN = /^\/(?:$|\*$|health$|p\/|setup\/|guest-auth\/|internal\/|mail\/deliver\/)/;

describe('files and folders without a login', () => {
    let ctx: TestCtx;
    let aliceId: string;
    let mountId: string;
    let privateParent: DrivePath;
    let folder: DrivePath;
    let sub: DrivePath;
    let deep: DrivePath;
    let doc: DrivePath;
    let chat: DrivePath;
    let loneFile: DrivePath;
    let siblingFile: DrivePath;
    let siblingFolder: DrivePath;
    let svgs: DrivePath[];
    let inFolder: Record<Reads, DrivePath>;

    function withPublicLinks(on: boolean): Promise<void> {
        return updateServerSettings({ sharing: { publicLinks: on } });
    }

    function urlOf(route: string, pathId: string): string {
        return route
            .replace(':ownerId', aliceId)
            .replace(':mountId', mountId)
            .replace(':pathId', pathId)
            .replace('thumb/:fileName', `thumb/${pathId}.webp`)
            .replace(':fileName', 'name');
    }

    function siblingOf(reads: Reads): DrivePath {
        return reads === 'folder' ? siblingFolder : siblingFile;
    }

    async function putACL(pathId: string, body: object): Promise<void> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${aliceId}/${mountId}/path/${pathId}/acl`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        expect(res.status).toBe(200);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const token = ctx.alice.user.sessionToken;
        aliceId = ctx.alice.user.id;
        mountId = await firstMountId(token, aliceId);
        const root = await driveGet(token, aliceId, mountId, 'root');
        const upload = (parentId: string, name: string, type: string, body: BlobPart): Promise<DrivePath> =>
            driveUpload(token, aliceId, mountId, parentId, new File([body], name, { type }));

        privateParent = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Private Parent' });
        folder = await drivePost(token, aliceId, mountId, `folder/${privateParent.id}`, { folderName: 'Open Folder' });
        sub = await drivePost(token, aliceId, mountId, `folder/${folder.id}`, { folderName: 'Sub' });
        deep = await upload(sub.id, 'deep.txt', 'text/plain', 'deep');
        doc = await drivePost(token, aliceId, mountId, `folder/${folder.id}/create/doc`, { fileName: 'Inside Doc' });
        chat = await drivePost(token, aliceId, mountId, `folder/${folder.id}/create/chat`, {
            fileName: 'inside-room',
        });
        inFolder = {
            folder,
            doc,
            text: await upload(folder.id, 'inside.txt', 'text/plain', 'hello visitor'),
            image: await upload(folder.id, 'pic.png', 'image/png', TEST_PNG_BYTES),
            vcard: await upload(folder.id, 'card.vcf', 'text/vcard', VCARD),
            eml: await upload(folder.id, 'mail.eml', 'message/rfc822', EML),
            ics: await upload(folder.id, 'cal.ics', 'text/calendar', ICS),
        };
        loneFile = await upload(privateParent.id, 'lone.txt', 'text/plain', 'lone');
        siblingFile = await upload(privateParent.id, 'sibling.txt', 'text/plain', 'secret');
        siblingFolder = await drivePost(token, aliceId, mountId, `folder/${privateParent.id}`, {
            folderName: 'Sibling Folder',
        });
        await upload(privateParent.id, 'sibling.png', 'image/png', TEST_PNG_BYTES);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('sibling.png')}"/></svg>`;
        svgs = [
            await upload(privateParent.id, 'pic.svg', 'image/svg+xml', svg),
            await upload(privateParent.id, 'pic-2.svg', 'image/svg+xml', svg),
        ];

        // The thumbnail is made in the background.
        await eventually(async () => {
            const res = await authedRequest(token, `/drive/${aliceId}/${mountId}/thumb/${inFolder.image.id}.webp`);
            return res.status === 200 ? true : undefined;
        }, 'the thumbnail');

        await withPublicLinks(true);
        // An entry beside the link, so a member's answer has an ACL to show.
        const charlie = { id: ctx.charlie.user.email, read: true, write: false };
        await putACL(folder.id, { visibility: 'link', add: [charlie] });
        await putACL(loneFile.id, { visibility: 'link', add: [charlie] });
        for (const { id } of svgs) await putACL(id, { visibility: 'link' });
    });

    afterAll(async () => {
        await withPublicLinks(false);
    });

    describe('each route', () => {
        for (const { route, reads, bytes } of LINK_ROUTES) {
            test(`${route} serves a path in a public folder as it serves its owner`, async () => {
                const url = urlOf(route, inFolder[reads].id);
                const owner = await authedRequest(ctx.alice.user.sessionToken, url);
                const visitor = await visit(url);
                expect(owner.status).toBeLessThan(400);
                expect(visitor.status).toBe(owner.status);
                if (bytes) expect(await visitor.bytes()).toEqual(await owner.bytes());
            });

            test(`${route} refuses a sibling of the public path`, async () => {
                await expectRefused(route, await visit(urlOf(route, siblingOf(reads).id)));
            });

            test(`${route} refuses an unknown id`, async () => {
                await expectRefused(route, await visit(urlOf(route, crypto.randomUUID())));
            });

            test(`${route} refuses the folder above the public path`, async () => {
                await expectRefused(route, await visit(urlOf(route, privateParent.id)));
            });

            test(`${route} tells a visitor's browser and a crawler to keep nothing`, async () => {
                const res = await visit(urlOf(route, inFolder[reads].id));
                expect(res.headers.get('cache-control')).toBe('no-store');
                expect(res.headers.get('x-robots-tag')).toBe('noindex');
            });

            test(`${route} answers a signed-in caller with the headers it had`, async () => {
                const url = urlOf(route, inFolder[reads].id);
                for (const token of [ctx.alice.user.sessionToken, ctx.bob.user.sessionToken]) {
                    const res = await authedRequest(token, url);
                    expect(res.status).toBeLessThan(400);
                    expect(res.headers.get('cache-control')).not.toBe('no-store');
                    expect(res.headers.get('x-robots-tag')).toBeNull();
                }
            });

            test(`${route} refuses while public links are off`, async () => {
                await withPublicLinks(false);
                try {
                    await expectRefused(route, await visit(urlOf(route, inFolder[reads].id)));
                } finally {
                    await withPublicLinks(true);
                }
            });
        }

        test('a public file on its own is served, and downloads', async () => {
            const path = await assertJson<DrivePath>(await visit(urlOf(LINK_ROUTES[0].route, loneFile.id)));
            expect(path.name).toBe('lone.txt');
            const download = await visit(urlOf(LINK_ROUTES[3].route, loneFile.id));
            expect(download.status).toBe(200);
            expect(await download.text()).toBe('lone');
        });

        test('a byte range of a public file is served', async () => {
            const res = await app.handle(
                new Request(`http://localhost${urlOf(LINK_ROUTES[3].route, loneFile.id)}`, {
                    headers: { range: 'bytes=1-2' },
                }),
            );
            expect(res.status).toBe(206);
            expect(await res.text()).toBe('on');
            expect(res.headers.get('cache-control')).toBe('no-store');
        });

        test('the permissions of a public path say it reads and does not write', async () => {
            for (const head of [folder, loneFile, deep]) {
                const res = await visit(urlOf(PERMISSIONS_ROUTE, head.id));
                expect(await assertJson(res)).toEqual({ canRead: true, canWrite: false });
            }
        });

        // The preview cache is one copy for every caller, so the visitor gets the member's: the sibling it names inlined.
        test('a public svg previews as its owner sees it, whoever asks first', async () => {
            const png = `data:image/png;base64,${Buffer.from(TEST_PNG_BYTES).toString('base64')}`;
            for (const [index, { id }] of svgs.entries()) {
                const url = urlOf(LINK_ROUTES[5].route, id);
                const ownerFirst = index === 0;
                const first = ownerFirst ? await authedRequest(ctx.alice.user.sessionToken, url) : await visit(url);
                const second = ownerFirst ? await visit(url) : await authedRequest(ctx.alice.user.sessionToken, url);
                const [visitor, owner] = ownerFirst ? [second, first] : [first, second];
                const body = await visitor.text();
                expect(body).toBe(await owner.text());
                expect(body).toContain(png);
            }
        });

        test('on a demo server every route refuses', async () => {
            process.env['EIGEN_DEMO'] = '1';
            try {
                for (const { route, reads } of LINK_ROUTES) {
                    await expectRefused(route, await visit(urlOf(route, inFolder[reads].id)));
                }
            } finally {
                delete process.env['EIGEN_DEMO'];
            }
        });

        test('an unknown owner answers 404 and a malformed one 400', async () => {
            const url = `/drive/${'a'.repeat(32)}/${mountId}/path/${loneFile.id}`;
            expect((await visit(url)).status).toBe(404);
            expect((await visit(`/drive/not an owner/${mountId}/path/${loneFile.id}`)).status).toBe(400);
        });
    });

    describe('what a visitor is handed', () => {
        function visitorPath(pathId: string): Promise<DrivePath> {
            return visit(urlOf(LINK_ROUTES[0].route, pathId)).then((res) => assertJson<DrivePath>(res));
        }

        function visitorList(route: string, pathId: string): Promise<DrivePath[]> {
            return visit(urlOf(route, pathId)).then((res) => assertJson<DrivePath[]>(res));
        }

        test('the public path has no ACL and no parent id', async () => {
            for (const head of [folder, loneFile]) {
                const path = await visitorPath(head.id);
                expect(path.id).toBe(head.id);
                expect(path.acl).toBeNull();
                expect(path.parentId).toBeNull();
            }
        });

        test('a child has no ACL and keeps its parent id', async () => {
            await putACL(sub.id, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });
            const child = await visitorPath(sub.id);
            expect(child.acl).toBeNull();
            expect(child.parentId).toBe(folder.id);
            expect((await visitorPath(deep.id)).parentId).toBe(sub.id);
        });

        test('a breadcrumb starts at the public path, which has no parent id', async () => {
            const crumbs = await visitorList(LINK_ROUTES[2].route, deep.id);
            expect(crumbs.map((crumb) => crumb.name)).toEqual(['Open Folder', 'Sub', 'deep.txt']);
            expect(crumbs.map((crumb) => crumb.parentId)).toEqual([null, folder.id, sub.id]);
            expect(crumbs.map((crumb) => crumb.acl)).toEqual([null, null, null]);
        });

        test('no answer names the private folder above the public path', async () => {
            for (const { route, reads, bytes } of LINK_ROUTES) {
                if (bytes) continue;
                const body = await (await visit(urlOf(route, inFolder[reads].id))).text();
                expect(body).not.toContain(privateParent.id);
            }
            expect(await (await visit(urlOf(LINK_ROUTES[0].route, loneFile.id))).text()).not.toContain(
                privateParent.id,
            );
        });

        test('a listing holds what the rule admits: no chat, no ACL, and each child names the folder', async () => {
            const owned = await driveGetList(ctx.alice.user.sessionToken, aliceId, mountId, `folder/${folder.id}`);
            const ownedIds = owned.map((path) => path.id);
            expect(ownedIds).toContain(chat.id);

            const listed = await visitorList(LINK_ROUTES[1].route, folder.id);
            expect(listed.map((path) => path.id).sort()).toEqual(ownedIds.filter((id) => id !== chat.id).sort());
            expect(listed.every((path) => path.acl === null && path.parentId === folder.id)).toBe(true);
        });

        test('a listing of a public document holds no chat folder and no database', async () => {
            const token = ctx.alice.user.sessionToken;
            const owned = await driveGetList(token, aliceId, mountId, `folder/${doc.id}`);
            expect(owned.map((path) => path.name)).toContain('chat');

            const listed = await visitorList(LINK_ROUTES[1].route, doc.id);
            expect(listed.filter((path) => path.name !== 'media')).toEqual([]);
        });

        test('a chat in a public folder answers 403 on its own id too', async () => {
            expect((await visit(urlOf(LINK_ROUTES[0].route, chat.id))).status).toBe(403);
        });
    });

    describe('a signed-in caller is served as before', () => {
        test('the owner reads the ACL, the parent id and the whole breadcrumb', async () => {
            const token = ctx.alice.user.sessionToken;
            const path = await driveGet(token, aliceId, mountId, `path/${folder.id}`);
            expect(path.acl).toEqual([{ id: ctx.charlie.user.email, read: true, write: false }]);
            expect(path.parentId).toBe(privateParent.id);
            const crumbs = await driveGetList(token, aliceId, mountId, `path/${deep.id}/breadcrumb`);
            expect(crumbs.map((crumb) => crumb.name).slice(-4)).toEqual([
                'Private Parent',
                'Open Folder',
                'Sub',
                'deep.txt',
            ]);
            const listed = await driveGetList(token, aliceId, mountId, `folder/${folder.id}`);
            expect(listed.map((child) => child.id)).toContain(chat.id);
        });

        test('a member with an ACL entry reads the path with its parent id', async () => {
            const path = await driveGet(ctx.charlie.user.sessionToken, aliceId, mountId, `path/${folder.id}`);
            expect(path.parentId).toBe(privateParent.id);
            expect(path.acl).not.toBeNull();
        });

        test('a signed-in non-member reads the public path as under signed-in view, and no sibling', async () => {
            const token = ctx.bob.user.sessionToken;
            const path = await driveGet(token, aliceId, mountId, `path/${loneFile.id}`);
            expect(path.parentId).toBe(privateParent.id);
            const sibling = await authedRequest(token, urlOf(LINK_ROUTES[0].route, siblingFile.id));
            expect(sibling.status).toBe(403);
        });

        test('the permissions route answers a member and a non-member as before', async () => {
            const permissions = (token: string, pathId: string) =>
                authedRequest(token, urlOf(PERMISSIONS_ROUTE, pathId)).then((res) => assertJson(res));
            expect(await permissions(ctx.alice.user.sessionToken, folder.id)).toEqual({
                canRead: true,
                canWrite: true,
            });
            expect(await permissions(ctx.charlie.user.sessionToken, folder.id)).toEqual({
                canRead: true,
                canWrite: false,
            });
            expect(await permissions(ctx.bob.user.sessionToken, loneFile.id)).toEqual({
                canRead: true,
                canWrite: false,
            });
            expect(await permissions(ctx.bob.user.sessionToken, siblingFile.id)).toEqual({
                canRead: false,
                canWrite: false,
            });
        });

        test('a login that no longer holds answers as a visitor', async () => {
            const res = await authedRequest('not-a-session', urlOf(LINK_ROUTES[0].route, loneFile.id));
            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('no-store');
            expect((await authedRequest('not-a-session', urlOf(LINK_ROUTES[0].route, siblingFile.id))).status).toBe(
                403,
            );
        });
    });

    describe('every other route', () => {
        // A route with a schema refuses a request without a body, query or valid param with 422 before it asks who calls.
        test('answers 401, or 422 before that, without a login', async () => {
            const linkRoutes = new Set<string>(LINK_ROUTES.map(({ route }) => `GET ${route}`));
            const served: string[] = [];
            const found = new Set<string>();
            for (const { method, path } of app.routes) {
                const name = `${method} ${path}`;
                if (linkRoutes.has(name)) {
                    found.add(name);
                    continue;
                }
                // The collab socket is not a request this test can send.
                if (method === 'WS' || method === 'OPTIONS' || OPEN_BY_DESIGN.test(path)) continue;
                const url = urlOf(path, loneFile.id).replace(/:\w+\??|\*/g, 'x');
                const { status } = await visit(url, method);
                if (status !== 401 && status !== 422) served.push(`${name} → ${status}`);
            }
            expect(served).toEqual([]);
            expect([...found].sort()).toEqual([...linkRoutes].sort());
        });

        // The walk above can't tell a refused body or query from a refused login, so the route files say who opts in.
        test('the routes that say linkAuth are the list, and none says optionalAuth', () => {
            const dir = join(import.meta.dir, '../../routes');
            const linkAuth: string[] = [];
            for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
                const text = readFileSync(join(dir, file), 'utf8');
                for (const chunk of text
                    .split(/(?=\.(?:get|post|put|patch|delete|ws|head|options|all)\(\s*['"]\/)/)
                    .slice(1)) {
                    expect(chunk).not.toMatch(/optionalAuth:\s*true/);
                    const route = /['"](\/[^'"]*)['"]/.exec(chunk)?.[1];
                    if (route !== undefined && /linkAuth:\s*true/.test(chunk)) linkAuth.push(route);
                }
            }
            expect(linkAuth.sort()).toEqual([...LINK_ROUTES.map(({ route }) => route), LINK_SOCKET].sort());
        });
    });

    describe('the trash', () => {
        test('a public path in the trash, or under a trashed folder, is refused', async () => {
            const token = ctx.alice.user.sessionToken;
            expect((await visit(urlOf(LINK_ROUTES[0].route, loneFile.id))).status).toBe(200);
            await driveDelete(token, aliceId, mountId, `path/${loneFile.id}`);
            await driveDelete(token, aliceId, mountId, `path/${folder.id}`);
            for (const { route, reads } of LINK_ROUTES) {
                await expectRefused(route, await visit(urlOf(route, inFolder[reads].id)));
            }
            expect((await visit(urlOf(LINK_ROUTES[0].route, loneFile.id))).status).toBe(403);
            expect((await visit(urlOf(LINK_ROUTES[3].route, loneFile.id))).status).toBe(403);
        });
    });
});
