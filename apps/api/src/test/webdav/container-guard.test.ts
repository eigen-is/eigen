import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { TestContext } from '../setup';
import { driveGet, driveGetList, drivePost, getTestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

// WebDAV follows the drive's rule for a document: a client may PUT or COPY a new file into its media/, and every other
// write inside it is the drive's one 423.
describe('WebDAV writes inside a document', () => {
    let ctx: TestContext;
    let mountId: string;
    let baseHref: string;
    let docName: string;
    let docPath: string;
    let rootId: string;
    const email = () => ctx.alice.user.email;
    const dest = (path: string) => ({ headers: { Destination: `http://localhost${path}` } });

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'GuardTest' },
        );
        docName = created.name;
        docPath = `${baseHref}/${docName}`;
        expect((await webdavRequest(email(), 'PUT', `${baseHref}/outside.txt`, { body: 'out' })).status).toBe(201);
        expect((await webdavRequest(email(), 'MKCOL', `${baseHref}/Outside/`)).status).toBe(201);
    });

    test('PUT of a new file into media/ succeeds', async () => {
        const res = await webdavRequest(email(), 'PUT', `${docPath}/media/new.txt`, { body: 'hello' });
        expect(res.status).toBe(201);
        const got = await webdavRequest(email(), 'GET', `${docPath}/media/new.txt`);
        expect(await got.text()).toBe('hello');
    });

    test('COPY of a new file into media/ succeeds', async () => {
        const res = await webdavRequest(
            email(),
            'COPY',
            `${baseHref}/outside.txt`,
            dest(`${docPath}/media/copied.txt`),
        );
        expect(res.status).toBe(201);
        const got = await webdavRequest(email(), 'GET', `${docPath}/media/copied.txt`);
        expect(await got.text()).toBe('out');
    });

    // An existing file is never moved in: it would be trapped there, and nothing in the document names it.
    test('MOVE of a file into media/ is a 423 and leaves the source where it was', async () => {
        expect((await webdavRequest(email(), 'PUT', `${baseHref}/into-media.txt`, { body: 'mine' })).status).toBe(201);
        const outcomes: string[] = [];
        for (const name of ['into-media.txt', 'renamed.txt']) {
            const res = await webdavRequest(
                email(),
                'MOVE',
                `${baseHref}/into-media.txt`,
                dest(`${docPath}/media/${name}`),
            );
            outcomes.push(`${res.status} ${await res.text()}`);
            expect((await webdavRequest(email(), 'GET', `${docPath}/media/${name}`)).status).toBe(404);
        }
        expect(outcomes).toEqual(Array(2).fill('423 Cannot change the inside of a document'));
        const source = await webdavRequest(email(), 'GET', `${baseHref}/into-media.txt`);
        expect(await source.text()).toBe('mine');
    });

    test('every other write inside the document is one 423', async () => {
        expect((await webdavRequest(email(), 'PUT', `${docPath}/media/kept.txt`, { body: 'kept' })).status).toBe(201);
        const proppatch = `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:x"><D:set><D:prop><Z:a>1</Z:a></D:prop></D:set></D:propertyupdate>`;
        const writes: Record<string, Response> = {
            'PUT into the document': await webdavRequest(email(), 'PUT', `${docPath}/intruder.txt`, { body: 'x' }),
            'PUT into chat/': await webdavRequest(email(), 'PUT', `${docPath}/chat/intruder.txt`, { body: 'x' }),
            'PUT over data.db': await webdavRequest(email(), 'PUT', `${docPath}/data.db`, { body: 'x' }),
            'PUT over a media file': await webdavRequest(email(), 'PUT', `${docPath}/media/kept.txt`, { body: 'x' }),
            'MKCOL in the document': await webdavRequest(email(), 'MKCOL', `${docPath}/Sub/`),
            'MKCOL in media/': await webdavRequest(email(), 'MKCOL', `${docPath}/media/Sub/`),
            'DELETE data.db': await webdavRequest(email(), 'DELETE', `${docPath}/data.db`),
            'DELETE a media file': await webdavRequest(email(), 'DELETE', `${docPath}/media/kept.txt`),
            'MOVE data.db out': await webdavRequest(email(), 'MOVE', `${docPath}/data.db`, dest(`${baseHref}/x.db`)),
            'MOVE a file in': await webdavRequest(
                email(),
                'MOVE',
                `${baseHref}/outside.txt`,
                dest(`${docPath}/outside.txt`),
            ),
            'COPY a file in': await webdavRequest(
                email(),
                'COPY',
                `${baseHref}/outside.txt`,
                dest(`${docPath}/chat/outside.txt`),
            ),
            'COPY a folder into media/': await webdavRequest(
                email(),
                'COPY',
                `${baseHref}/Outside/`,
                dest(`${docPath}/media/Outside/`),
            ),
            'PROPPATCH data.db': await webdavRequest(email(), 'PROPPATCH', `${docPath}/data.db`, { body: proppatch }),
        };
        const outcomes: Record<string, string> = {};
        for (const [write, res] of Object.entries(writes)) outcomes[write] = `${res.status} ${await res.text()}`;
        expect(outcomes).toEqual(
            Object.fromEntries(
                Object.keys(writes).map((write) => [write, '423 Cannot change the inside of a document']),
            ),
        );
        const got = await webdavRequest(email(), 'GET', `${docPath}/media/kept.txt`);
        expect(await got.text()).toBe('kept');
        const names = (
            await driveGetList(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${rootId}`)
        ).map((path) => path.name);
        expect(names).toContain('outside.txt');
    });

    test('the document itself moves as a unit', async () => {
        await webdavRequest(email(), 'MKCOL', `${baseHref}/Archive/`);
        const moved = `${baseHref}/Archive/${docName}`;
        const res = await webdavRequest(email(), 'MOVE', docPath, dest(moved));
        expect([201, 204]).toContain(res.status);
        const verify = await webdavRequest(email(), 'PROPFIND', `${moved}/`, { headers: { Depth: '1' } });
        expect(verify.status).toBe(207);
    });
});
