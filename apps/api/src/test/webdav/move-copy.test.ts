import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home';
import type { TestUser } from '../setup';
import {
    authedRequest,
    capUserDrive,
    createTestUser,
    driveGet,
    drivePost,
    drivePut,
    getTestContext,
    setMaxUploadSizeMB,
} from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV MOVE/COPY', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let baseHref: string;
    const lockBody = `<?xml version="1.0" encoding="utf-8" ?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    test('MOVE renames in place', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-rename.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-rename.txt`, {
            headers: { Destination: `http://localhost${baseHref}/renamed.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const oldGet = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/move-rename.txt`);
        expect(oldGet.status).toBe(404);
        const newGet = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/renamed.txt`);
        expect(newGet.status).toBe(200);
        expect(await newGet.text()).toBe('a');
    });

    test('MOVE into a different folder', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/MoveTarget/`);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-into.txt`, { body: 'b' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-into.txt`, {
            headers: { Destination: `http://localhost${baseHref}/MoveTarget/move-into.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const target = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/MoveTarget/move-into.txt`);
        expect(await target.text()).toBe('b');
    });

    test('MOVE with Overwrite: F over existing → 412', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/source.txt`, { body: 'src' });
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/conflict.txt`, { body: 'dest' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/source.txt`, {
            headers: {
                Destination: `http://localhost${baseHref}/conflict.txt`,
                Overwrite: 'F',
            },
        });
        expect(res.status).toBe(412);
    });

    test('COPY in-mount preserves source', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/copy-src.txt`, { body: 'orig' });
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/copy-src.txt`, {
            headers: { Destination: `http://localhost${baseHref}/copy-dst.txt` },
        });
        expect([201, 204]).toContain(res.status);
        const src = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/copy-src.txt`);
        const dst = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/copy-dst.txt`);
        expect(await src.text()).toBe('orig');
        expect(await dst.text()).toBe('orig');
    });

    test('COPY a folder into its own subtree → 409 (no infinite recursion)', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyCycle/`);
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyCycle/Inner/`);
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/CopyCycle`, {
            headers: { Destination: `http://localhost${baseHref}/CopyCycle/Inner/CopyCycle` },
        });
        expect(res.status).toBe(409);
    });

    test('COPY a folder into an unrelated folder succeeds', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyFrom/`);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/CopyFrom/note.txt`, { body: 'hi' });
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/CopyInto/`);
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/CopyFrom`, {
            headers: { Destination: `http://localhost${baseHref}/CopyInto/CopyFrom` },
        });
        expect([201, 204]).toContain(res.status);
        const copied = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/CopyInto/CopyFrom/note.txt`);
        expect(await copied.text()).toBe('hi');
    });

    test('MOVE with no Destination → 400', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/no-dest.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/no-dest.txt`);
        expect(res.status).toBe(400);
    });

    test('MOVE missing parent → 409', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/orphan.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/orphan.txt`, {
            headers: { Destination: `http://localhost${baseHref}/no-such-folder/x.txt` },
        });
        expect(res.status).toBe(409);
    });

    test('MOVE Destination outside /webdav → 400', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/elsewhere.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/elsewhere.txt`, {
            headers: { Destination: `http://localhost/somewhere-else/x.txt` },
        });
        expect(res.status).toBe(400);
    });

    test('MOVE onto its own URL → 403 and the file is untouched', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-self.txt`, { body: 'keep' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-self.txt`, {
            headers: { Destination: `http://localhost${baseHref}/move-self.txt` },
        });
        expect(res.status).toBe(403);
        const after = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/move-self.txt`);
        expect(after.status).toBe(200);
        expect(await after.text()).toBe('keep');
    });

    // A name is found without case, so the destination of such a rename resolves to the source itself.
    test('MOVE that only changes the case of the name renames the file', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/case-only.txt`, { body: 'keep' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/case-only.txt`, {
            headers: { Destination: `http://localhost${baseHref}/Case-Only.txt` },
        });
        expect(res.status).toBe(201);
        const { drive } = await getHome(ctx.alice.user.id);
        expect((await drive.resolvePath(mountId, '/case-only.txt'))?.name).toBe('Case-Only.txt');
        expect((await drive.listTrash(mountId)).map((path) => path.name.toLowerCase())).not.toContain('case-only.txt');
        const after = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/Case-Only.txt`);
        expect(await after.text()).toBe('keep');
    });

    test('COPY that only changes the case of the name → 409 and the file is untouched', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/case-copy.txt`, { body: 'keep' });
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/case-copy.txt`, {
            headers: { Destination: `http://localhost${baseHref}/Case-Copy.txt` },
        });
        expect(res.status).toBe(409);
        const { drive } = await getHome(ctx.alice.user.id);
        expect((await drive.resolvePath(mountId, '/Case-Copy.txt'))?.name).toBe('case-copy.txt');
    });

    for (const verb of ['MOVE', 'COPY']) {
        test(`${verb} over a folder the source is in → 409 and both stay`, async () => {
            await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/Over${verb}/`);
            await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/Over${verb}/b/`);
            await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/Over${verb}/b/x.txt`, { body: 'keep' });
            const res = await webdavRequest(ctx.alice.user.email, verb, `${baseHref}/Over${verb}/b/x.txt`, {
                headers: { Destination: `http://localhost${baseHref}/Over${verb}/b`, Overwrite: 'T' },
            });
            expect(res.status).toBe(409);
            const after = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/Over${verb}/b/x.txt`);
            expect(`${after.status} ${await after.text()}`).toBe('200 keep');
            const { drive } = await getHome(ctx.alice.user.id);
            expect((await drive.listTrash(mountId)).map((path) => path.name)).not.toContain('b');
        });
    }

    test('COPY onto its own URL → 403 and the file is untouched', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/copy-self.txt`, { body: 'keep' });
        const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/copy-self.txt`, {
            headers: { Destination: `http://localhost${baseHref}/copy-self.txt` },
        });
        expect(res.status).toBe(403);
        const after = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/copy-self.txt`);
        expect(after.status).toBe(200);
        expect(await after.text()).toBe('keep');
    });

    test('malformed percent-encoding in Destination → 400', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/move-badpct.txt`, { body: 'x' });
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/move-badpct.txt`, {
            headers: { Destination: `http://localhost${baseHref}/bad%E0.txt` },
        });
        expect(res.status).toBe(400);
    });

    // Behind the bundled Caddy the API lives under /eigen. Caddy strips it from the request path but not from the
    // Destination header, so a client that sends back the full URL it was given names /eigen/webdav/...
    describe('a Destination under the API base path', () => {
        const before = process.env['VITE_API_HOST'];
        beforeAll(() => {
            process.env['VITE_API_HOST'] = '/eigen';
        });
        afterAll(() => {
            if (before === undefined) delete process.env['VITE_API_HOST'];
            else process.env['VITE_API_HOST'] = before;
        });

        test('MOVE to https://host/eigen/webdav/... lands in the mount', async () => {
            await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/base-move.txt`, { body: 'm' });
            const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/base-move.txt`, {
                headers: { Destination: `https://demo.example/eigen${baseHref}/base-moved.txt` },
            });
            expect(res.status).toBe(201);
            const moved = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/base-moved.txt`);
            expect(await moved.text()).toBe('m');
        });

        test('COPY to /eigen/webdav/... lands in the mount', async () => {
            await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/base-copy.txt`, { body: 'c' });
            const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/base-copy.txt`, {
                headers: { Destination: `/eigen${baseHref}/base-copied.txt` },
            });
            expect(res.status).toBe(201);
            const copied = await webdavRequest(ctx.alice.user.email, 'GET', `${baseHref}/base-copied.txt`);
            expect(await copied.text()).toBe('c');
        });

        test('a plain /webdav/... Destination still works', async () => {
            await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/base-plain.txt`, { body: 'p' });
            const res = await webdavRequest(ctx.alice.user.email, 'COPY', `${baseHref}/base-plain.txt`, {
                headers: { Destination: `http://localhost${baseHref}/base-plain-copy.txt` },
            });
            expect(res.status).toBe(201);
        });

        test('a Destination outside /eigen/webdav, or under another prefix, → 400', async () => {
            await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/base-elsewhere.txt`, { body: 'x' });
            for (const destination of [
                `https://demo.example/eigen/other${baseHref}/x.txt`,
                `https://demo.example/other${baseHref}/x.txt`,
            ]) {
                const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/base-elsewhere.txt`, {
                    headers: { Destination: destination },
                });
                expect(res.status).toBe(400);
            }
        });
    });

    // A COPY writes what a PUT would, so it meets the same limits, before it writes anything.
    describe('the limits of a COPY', () => {
        let user: TestUser;
        let href: string;
        const MB = 1024 * 1024;

        let restoreDrive: () => Promise<void>;

        // The drive holds 100 MB: its own cap and the server default both, as the larger of the two applies.
        beforeAll(async () => {
            user = await createTestUser(`dav-copy-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'D');
            const driveId = await getDefaultMountId(user.sessionToken, user.id);
            restoreDrive = await capUserDrive(user.id, driveId, 100);
            href = `/webdav/${user.id}/${driveId}`;
            await webdavRequest(user.email, 'MKCOL', `${href}/big/`);
            for (const name of ['a.bin', 'b.bin']) {
                const put = await webdavRequest(user.email, 'PUT', `${href}/big/${name}`, {
                    body: new Uint8Array(20 * MB),
                });
                expect(put.status).toBe(201);
            }
        });

        afterAll(async () => {
            await restoreDrive();
        });

        function copyTo(source: string, destination: string): Promise<Response> {
            return webdavRequest(user.email, 'COPY', `${href}/${source}`, {
                headers: { Destination: `http://localhost${href}/${destination}` },
            });
        }

        async function used(): Promise<number> {
            const drive = (await getHome(user.id)).drive;
            return drive.size(await getDefaultMountId(user.sessionToken, user.id));
        }

        test('a file past the per-file limit is a 413, as a PUT is, and writes nothing', async () => {
            const put = await webdavRequest(user.email, 'PUT', `${href}/two-mb.bin`, { body: new Uint8Array(2 * MB) });
            expect(put.status).toBe(201);
            const before = getServerSettings().quotas.maxUploadSizeMB;
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                expect((await copyTo('two-mb.bin', 'two-mb-copy.bin')).status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, before);
            }
            expect((await webdavRequest(user.email, 'GET', `${href}/two-mb-copy.bin`)).status).toBe(404);
        });

        test('a folder past the free space is a 507, as a PUT is, and writes nothing', async () => {
            expect((await copyTo('big', 'big-1')).status).toBe(201);
            // The folder, its first copy and the 2 MB file use 82 MB, so 18 MB is free.
            expect((await copyTo('big', 'big-2')).status).toBe(507);
            expect(await used()).toBe(82 * MB);
            const second = await webdavRequest(user.email, 'PROPFIND', `${href}/big-2`, { headers: { Depth: '0' } });
            expect(second.status).toBe(404);
        });

        test('a file past the free space but under the per-file limit is a 507, as a PUT is', async () => {
            // 18 MB is free, and the 20 MB file is under the 35 MB per-file limit.
            expect((await copyTo('big/a.bin', 'a-copy.bin')).status).toBe(507);
            expect(await used()).toBe(82 * MB);
            expect((await webdavRequest(user.email, 'GET', `${href}/a-copy.bin`)).status).toBe(404);
        });

        // An Overwrite: T COPY trashes the destination only once nothing can refuse it any more.
        test('a COPY refused for space or size leaves the file it would overwrite', async () => {
            for (const name of ['keep-507.txt', 'keep-413.txt']) {
                expect((await webdavRequest(user.email, 'PUT', `${href}/${name}`, { body: 'old' })).status).toBe(201);
            }
            expect((await copyTo('big/a.bin', 'keep-507.txt')).status).toBe(507);
            const before = getServerSettings().quotas.maxUploadSizeMB;
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
            try {
                expect((await copyTo('two-mb.bin', 'keep-413.txt')).status).toBe(413);
            } finally {
                await setMaxUploadSizeMB(ctx.alice.user.sessionToken, before);
            }
            for (const name of ['keep-507.txt', 'keep-413.txt']) {
                expect(await (await webdavRequest(user.email, 'GET', `${href}/${name}`)).text()).toBe('old');
            }
        });
    });

    // A MOVE is one write: nothing is trashed, moved or renamed unless all of it goes through.
    describe('a MOVE over an existing destination', () => {
        const email = () => ctx.alice.user.email;
        const move = (source: string, destination: string): Promise<Response> =>
            webdavRequest(email(), 'MOVE', `${baseHref}/${source}`, {
                headers: { Destination: `http://localhost${baseHref}/${destination}`, Overwrite: 'T' },
            });
        const read = async (path: string): Promise<string> => {
            const res = await webdavRequest(email(), 'GET', `${baseHref}/${path}`);
            return `${res.status} ${await res.text()}`;
        };
        const trashNames = async (): Promise<string[]> =>
            (await (await getHome(ctx.alice.user.id)).drive.listTrash(mountId)).map((path) => path.name);

        // Word and Excel save this way, so the file must stay the one that is shared, watched and has the history.
        test('of a file over a file keeps the file, with its sharing, type and history, and gives it the bytes', async () => {
            const { drive } = await getHome(ctx.alice.user.id);
            await webdavRequest(email(), 'PUT', `${baseHref}/report.docx`, { body: 'old' });
            const created = await drive.resolvePath(mountId, '/report.docx');
            if (!created) throw new Error('expected the file');
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${created.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            const report = await drive.getPath(mountId, created.id);
            if (!report?.acl?.length) throw new Error('expected the share');
            const eventsBefore = (await drive.getFileHistory(mountId, report.id)).map((event) => event.eventType);

            await webdavRequest(email(), 'PUT', `${baseHref}/~WRD0001.tmp`, { body: 'new' });
            expect((await move('~WRD0001.tmp', 'report.docx')).status).toBe(204);

            const saved = await drive.resolvePath(mountId, '/report.docx');
            expect(saved?.id).toBe(report.id);
            expect(saved?.mimeType).toBe(report.mimeType);
            expect(saved?.acl).toEqual(report.acl);
            const sharee = await webdavRequest(ctx.bob.user.email, 'GET', `${baseHref}/report.docx`);
            expect(`${sharee.status} ${await sharee.text()}`).toBe('200 new');
            const download = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${report.id}/download`,
            );
            expect(download.headers.get('Content-Type')).toBe(Bun.file('report.docx').type);
            expect(download.headers.get('Content-Disposition')).toContain('report.docx');
            expect(await download.text()).toBe('new');

            const events = (await drive.getFileHistory(mountId, report.id)).map((event) => event.eventType);
            expect(events.toSorted()).toEqual([...eventsBefore, 'uploaded' as const].toSorted());
            expect(await drive.resolvePath(mountId, '/~WRD0001.tmp')).toBeNull();
            const trash = await trashNames();
            expect(trash).not.toContain('report.docx');
            expect(trash).not.toContain('~WRD0001.tmp');
        });

        test('of a file over a locked file keeps the lock of the client that sent its token', async () => {
            await webdavRequest(email(), 'PUT', `${baseHref}/mv-locked.txt`, { body: 'old' });
            await webdavRequest(email(), 'PUT', `${baseHref}/mv-locked.tmp`, { body: 'new' });
            const lock = await webdavRequest(email(), 'LOCK', `${baseHref}/mv-locked.txt`, {
                body: lockBody,
                headers: { 'Content-Type': 'application/xml' },
            });
            const token = (lock.headers.get('Lock-Token') ?? '').replace(/^<|>$/g, '');
            const res = await webdavRequest(email(), 'MOVE', `${baseHref}/mv-locked.tmp`, {
                headers: {
                    Destination: `http://localhost${baseHref}/mv-locked.txt`,
                    Overwrite: 'T',
                    If: `<http://localhost${baseHref}/mv-locked.txt> (<${token}>)`,
                },
            });
            expect(res.status).toBe(204);
            expect(await read('mv-locked.txt')).toBe('200 new');
            const unlocked = await webdavRequest(email(), 'PUT', `${baseHref}/mv-locked.txt`, { body: 'no token' });
            expect(unlocked.status).toBe(423);
            const unlock = await webdavRequest(email(), 'UNLOCK', `${baseHref}/mv-locked.txt`, {
                headers: { 'Lock-Token': `<${token}>` },
            });
            expect(unlock.status).toBe(204);
        });

        test('of a file over a folder, or a folder over a folder or a file, trashes what was there', async () => {
            const make = (kind: string, name: string): Promise<Response> =>
                kind === 'folder'
                    ? webdavRequest(email(), 'MKCOL', `${baseHref}/${name}`)
                    : webdavRequest(email(), 'PUT', `${baseHref}/${name}`, { body: name });
            for (const { source, target } of [
                { source: 'file', target: 'folder' },
                { source: 'folder', target: 'folder' },
                { source: 'folder', target: 'file' },
            ] as const) {
                const from = `mv-${source}-over-${target}-src`;
                const to = `mv-${source}-over-${target}`;
                expect((await make(source, from)).status).toBe(201);
                expect((await make(target, to)).status).toBe(201);
                expect((await move(from, to)).status).toBe(204);
                expect(await trashNames()).toContain(to);
                const landed = await (await getHome(ctx.alice.user.id)).drive.resolvePath(mountId, `/${to}`);
                expect(landed?.type).toBe(source);
            }
        });

        test("over a file in a document's media/ is a 423 and changes nothing", async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/create/doc`,
                { fileName: 'MvMediaDoc' },
            );
            await webdavRequest(email(), 'PUT', `${baseHref}/mv-into-media.txt`, { body: 'new' });
            await webdavRequest(email(), 'PUT', `${baseHref}/${doc.name}/media/kept.txt`, { body: 'old' });
            const res = await move('mv-into-media.txt', `${doc.name}/media/kept.txt`);
            expect(`${res.status} ${await res.text()}`).toBe('423 Cannot change the inside of a document');
            expect(await read(`${doc.name}/media/kept.txt`)).toBe('200 old');
            expect(await read('mv-into-media.txt')).toBe('200 new');
            expect(await trashNames()).not.toContain('kept.txt');
        });

        test('into another folder under a new name lands beside a file with the old name', async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/MvFrom/`);
            await webdavRequest(email(), 'MKCOL', `${baseHref}/MvTo/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/MvFrom/x.txt`, { body: 'moved' });
            await webdavRequest(email(), 'PUT', `${baseHref}/MvTo/x.txt`, { body: 'stays' });
            expect((await move('MvFrom/x.txt', 'MvTo/y.txt')).status).toBe(201);
            expect(await read('MvTo/y.txt')).toBe('200 moved');
            expect(await read('MvTo/x.txt')).toBe('200 stays');
            expect((await webdavRequest(email(), 'GET', `${baseHref}/MvFrom/x.txt`)).status).toBe(404);
        });

        test('of a folder into its own subtree is a 409 and leaves the destination', async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/MvCycle/`);
            await webdavRequest(email(), 'MKCOL', `${baseHref}/MvCycle/Inner/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/MvCycle/Inner/kept-409.txt`, { body: 'old' });
            expect((await move('MvCycle', 'MvCycle/Inner/kept-409.txt')).status).toBe(409);
            expect(await read('MvCycle/Inner/kept-409.txt')).toBe('200 old');
        });

        test('of a part of a document is a 423 and leaves the destination', async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/create/doc`,
                { fileName: 'MvDoc' },
            );
            await webdavRequest(email(), 'PUT', `${baseHref}/kept-423.db`, { body: 'old' });
            const res = await move(`${doc.name}/data.db`, 'kept-423.db');
            expect(`${res.status} ${await res.text()}`).toBe('423 Cannot change the inside of a document');
            expect(await read('kept-423.db')).toBe('200 old');
            expect(await trashNames()).not.toContain('kept-423.db');
        });
    });

    // RFC 4918 §9.8.3: Depth 0 copies the folder without its members. It never overwrites, whatever Overwrite says.
    describe('a Depth 0 COPY of a folder', () => {
        const email = () => ctx.alice.user.email;
        const copy = (source: string, destination: string): Promise<Response> =>
            webdavRequest(email(), 'COPY', `${baseHref}/${source}`, {
                headers: { Destination: `http://localhost${baseHref}/${destination}`, Overwrite: 'T', Depth: '0' },
            });
        const read = async (path: string): Promise<string> => {
            const res = await webdavRequest(email(), 'GET', `${baseHref}/${path}`);
            return `${res.status} ${await res.text()}`;
        };
        const trashNames = async (): Promise<string[]> =>
            (await (await getHome(ctx.alice.user.id)).drive.listTrash(mountId)).map((path) => path.name);

        test('to a free name creates the folder without its members', async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/D0From/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/D0From/member.txt`, { body: 'm' });
            expect((await copy('D0From', 'D0To')).status).toBe(201);
            const { drive } = await getHome(ctx.alice.user.id);
            expect((await drive.resolvePath(mountId, '/D0To'))?.name).toBe('D0To');
            expect(await drive.resolvePath(mountId, '/D0To/member.txt')).toBeNull();
        });

        test('onto an existing folder is a 412 and leaves it with its members', async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/D0Src/`);
            await webdavRequest(email(), 'MKCOL', `${baseHref}/D0Old/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/D0Old/kept.txt`, { body: 'old' });
            expect((await copy('D0Src', 'D0Old')).status).toBe(412);
            expect(await read('D0Old/kept.txt')).toBe('200 old');
            expect(await trashNames()).not.toContain('D0Old');
        });

        test("onto the source's own parent is a 412 and leaves both", async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/D0Parent/`);
            await webdavRequest(email(), 'MKCOL', `${baseHref}/D0Parent/child/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/D0Parent/child/kept.txt`, { body: 'old' });
            expect((await copy('D0Parent/child', 'D0Parent')).status).toBe(412);
            expect(await read('D0Parent/child/kept.txt')).toBe('200 old');
            expect(await trashNames()).not.toContain('D0Parent');
        });
    });

    describe('a COPY over an existing destination', () => {
        const email = () => ctx.alice.user.email;
        const copy = (source: string, destination: string): Promise<Response> =>
            webdavRequest(email(), 'COPY', `${baseHref}/${source}`, {
                headers: { Destination: `http://localhost${baseHref}/${destination}`, Overwrite: 'T' },
            });
        const trashNames = async (): Promise<string[]> =>
            (await (await getHome(ctx.alice.user.id)).drive.listTrash(mountId)).map((path) => path.name);

        test('of a file over a file keeps both files and gives the destination the bytes', async () => {
            const { drive } = await getHome(ctx.alice.user.id);
            await webdavRequest(email(), 'PUT', `${baseHref}/over-new.txt`, { body: 'new' });
            await webdavRequest(email(), 'PUT', `${baseHref}/over-old.txt`, { body: 'old' });
            const old = await drive.resolvePath(mountId, '/over-old.txt');
            expect((await copy('over-new.txt', 'over-old.txt')).status).toBe(204);
            expect((await drive.resolvePath(mountId, '/over-old.txt'))?.id).toBe(old?.id);
            expect(await (await webdavRequest(email(), 'GET', `${baseHref}/over-old.txt`)).text()).toBe('new');
            expect(await (await webdavRequest(email(), 'GET', `${baseHref}/over-new.txt`)).text()).toBe('new');
            expect(await trashNames()).not.toContain('over-old.txt');
        });

        test('of a file over a folder trashes the folder', async () => {
            await webdavRequest(email(), 'PUT', `${baseHref}/over-file.txt`, { body: 'new' });
            await webdavRequest(email(), 'MKCOL', `${baseHref}/over-folder`);
            expect((await copy('over-file.txt', 'over-folder')).status).toBe(204);
            expect(await (await webdavRequest(email(), 'GET', `${baseHref}/over-folder`)).text()).toBe('new');
            expect(await trashNames()).toContain('over-folder');
        });

        test('into its own subtree is a 409 and leaves the destination', async () => {
            await webdavRequest(email(), 'MKCOL', `${baseHref}/OverCycle/`);
            await webdavRequest(email(), 'MKCOL', `${baseHref}/OverCycle/Inner/`);
            await webdavRequest(email(), 'PUT', `${baseHref}/OverCycle/Inner/kept-409.txt`, { body: 'old' });
            expect((await copy('OverCycle', 'OverCycle/Inner/kept-409.txt')).status).toBe(409);
            const kept = await webdavRequest(email(), 'GET', `${baseHref}/OverCycle/Inner/kept-409.txt`);
            expect(await kept.text()).toBe('old');
        });

        test("over a file in a document's media/ is a 423 and leaves the destination", async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/create/doc`,
                { fileName: 'OverDoc' },
            );
            await webdavRequest(email(), 'PUT', `${baseHref}/over-423.txt`, { body: 'new' });
            await webdavRequest(email(), 'PUT', `${baseHref}/${doc.name}/media/kept-423.txt`, { body: 'old' });
            const res = await copy('over-423.txt', `${doc.name}/media/kept-423.txt`);
            expect(`${res.status} ${await res.text()}`).toBe('423 Cannot change the inside of a document');
            const kept = await webdavRequest(email(), 'GET', `${baseHref}/${doc.name}/media/kept-423.txt`);
            expect(await kept.text()).toBe('old');
            expect(await trashNames()).not.toContain('kept-423.txt');
        });
    });

    // The handler checks Overwrite and the locks on what holds the name. The drive writes many awaits later.
    describe('a destination that appears after the request checked the name', () => {
        beforeAll(async () => {
            expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/Appears`)).status).toBe(201);
            const folder = await (await getHome(ctx.alice.user.id)).drive.resolvePath(mountId, '/Appears');
            if (!folder) throw new Error('expected the folder');
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${folder.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: true }],
            });
        });

        for (const verb of ['MOVE', 'COPY']) {
            test(`${verb} with Overwrite: F is a 409 and leaves the file and its lock`, async () => {
                const src = `${baseHref}/Appears/${verb}-src.txt`;
                const dest = `${baseHref}/Appears/${verb}-dest.docx`;
                expect((await webdavRequest(ctx.bob.user.email, 'PUT', src, { body: 'bob' })).status).toBe(201);
                const { drive } = await getHome(ctx.alice.user.id);
                const source = await drive.resolvePath(mountId, `/Appears/${verb}-src.txt`);
                if (!source) throw new Error('expected the source');
                const { mount } = await drive.resolveFile(mountId, source.id);

                // The drive reads the source as its first step, so Alice's Save as lands right after the handler's checks.
                const getActivePath = mount.getActivePath.bind(mount);
                const saved: number[] = [];
                let started = false;
                const gate = spyOn(mount, 'getActivePath').mockImplementation(async (pathId: string) => {
                    if (pathId === source.id && !started) {
                        started = true;
                        const lock = await webdavRequest(ctx.alice.user.email, 'LOCK', dest, {
                            body: lockBody,
                            headers: { 'Content-Type': 'application/xml' },
                        });
                        const token = (lock.headers.get('Lock-Token') ?? '').replace(/^<|>$/g, '');
                        const put = await webdavRequest(ctx.alice.user.email, 'PUT', dest, {
                            body: 'alice',
                            headers: { If: `(<${token}>)` },
                        });
                        saved.push(lock.status, put.status);
                    }
                    return getActivePath(pathId);
                });
                let res: Response;
                try {
                    res = await webdavRequest(ctx.bob.user.email, verb, src, {
                        headers: { Destination: `http://localhost${dest}`, Overwrite: 'F' },
                    });
                } finally {
                    gate.mockRestore();
                }

                expect(saved).toEqual([201, 204]);
                expect(res.status).toBe(409);
                expect(await (await webdavRequest(ctx.alice.user.email, 'GET', dest)).text()).toBe('alice');
                expect((await drive.listTrash(mountId)).map((path) => path.name)).not.toContain(`${verb}-dest.docx`);
                expect((await webdavRequest(ctx.bob.user.email, 'PUT', dest, { body: 'bob' })).status).toBe(423);
                expect(await (await webdavRequest(ctx.bob.user.email, 'GET', src)).text()).toBe('bob');
            });
        }
    });

    test('MOVE of a folder past 256 levels → 400 and leaves the folder it would overwrite', async () => {
        const home = await getHome(ctx.alice.user.id);
        let parentId = (await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root')).id;
        const names: string[] = [];
        for (let depth = 1; depth <= 255; depth++) {
            const name = depth === 1 ? 'MvDeep' : `d${depth}`;
            names.push(name);
            parentId = (await home.drive.createFolder(mountId, parentId, name, home.user)).id;
        }
        const kept = `${baseHref}/${names.join('/')}/kept`;
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', kept)).status).toBe(201);
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/MvTwoLevels`)).status).toBe(201);
        expect((await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/MvTwoLevels/inner`)).status).toBe(201);

        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${baseHref}/MvTwoLevels`, {
            headers: { Destination: `http://localhost${kept}`, Overwrite: 'T' },
        });
        expect(`${res.status} ${await res.text()}`).toBe('400 Folders can be nested at most 256 levels deep');
        expect((await webdavRequest(ctx.alice.user.email, 'PROPFIND', kept, { headers: { Depth: '0' } })).status).toBe(
            207,
        );
    });
});
