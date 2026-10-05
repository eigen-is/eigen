import { beforeAll, describe, expect, test } from 'bun:test';
import { driveGet, drivePost, getTestContext, type TestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV container internals guard', () => {
    let ctx: TestContext;
    let mountId: string;
    let baseHref: string;
    let docName: string;
    let docPath: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const rootId = (root as { id: string }).id;

        const created = await drivePost<{ name: string }>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'GuardTest' },
        );
        docName = created.name;
        docPath = `${baseHref}/${docName}`;
    });

    test('PUT inside container → 423', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'PUT', `${docPath}/intruder.txt`, {
            body: 'x',
        });
        expect(res.status).toBe(423);
    });

    test('MKCOL inside container → 423', async () => {
        const res = await webdavRequest(ctx.alice.user.email, 'MKCOL', `${docPath}/Sub/`);
        expect(res.status).toBe(423);
    });

    test('DELETE child inside container → 423', async () => {
        const propfind = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${docPath}/`, {
            headers: { Depth: '1' },
        });
        const body = await propfind.text();
        const childMatch = body.match(new RegExp(`<D:href>${docPath}/([^/<]+)</D:href>`));
        if (!childMatch) {
            const synthetic = await webdavRequest(ctx.alice.user.email, 'DELETE', `${docPath}/anything.db`);
            expect([404, 423]).toContain(synthetic.status);
            return;
        }
        const childName = childMatch[1];
        const res = await webdavRequest(ctx.alice.user.email, 'DELETE', `${docPath}/${childName}`);
        expect(res.status).toBe(423);
    });

    test('MOVE child inside container → 423', async () => {
        const propfind = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${docPath}/`, {
            headers: { Depth: '1' },
        });
        const body = await propfind.text();
        const childMatch = body.match(new RegExp(`<D:href>${docPath}/([^/<]+)</D:href>`));
        const childName = childMatch ? childMatch[1] : 'anything.db';
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', `${docPath}/${childName}`, {
            headers: { Destination: `http://localhost${docPath}/renamed.bin` },
        });
        expect([423, 404]).toContain(res.status);
    });

    test('Container itself can be moved as a unit', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/Archive/`);
        const dest = `${baseHref}/Archive/${docName}`;
        const res = await webdavRequest(ctx.alice.user.email, 'MOVE', docPath, {
            headers: { Destination: `http://localhost${dest}` },
        });
        expect([201, 204]).toContain(res.status);

        const verify = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${dest}/`, {
            headers: { Depth: '1' },
        });
        expect(verify.status).toBe(207);
        expect(await verify.text()).toContain('<D:multistatus');
    });
});
