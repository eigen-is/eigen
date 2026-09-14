import { beforeAll, describe, expect, test } from 'bun:test';
import { XMLValidator } from 'fast-xml-parser';
import { getTestContext, type TestContext } from '../setup';
import { getDefaultMountId, webdavRequest } from './setup';

describe('WebDAV PROPPATCH', () => {
    let ctx: TestContext;
    let mountId: string;
    let baseHref: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await getDefaultMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        baseHref = `/webdav/${ctx.alice.user.id}/${mountId}`;
    });

    test('PROPPATCH set persists across PROPFIND', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch.txt`, { body: 'a' });
        const body = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test">
  <D:set><D:prop><Z:Win32CreationTime>Mon, 01 Jan 2024 00:00:00 GMT</Z:Win32CreationTime></D:prop></D:set>
</D:propertyupdate>`;
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch.txt`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(207);
        expect(await res.text()).toContain('HTTP/1.1 200 OK');

        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/proppatch.txt`, {
            headers: { Depth: '0' },
        });
        const findBody = await find.text();
        expect(findBody).toContain('Win32CreationTime');
        expect(findBody).toContain('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    test('PROPPATCH remove returns 207 even when prop missing', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-rm.txt`, { body: 'b' });
        const body = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test">
  <D:remove><D:prop><Z:NeverSet/></D:prop></D:remove>
</D:propertyupdate>`;
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-rm.txt`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(207);
        expect(await res.text()).toContain('HTTP/1.1 200 OK');
    });

    test('PROPPATCH on protected property returns 403 in propstat', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-protected.txt`, { body: 'c' });
        const body = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:">
  <D:set><D:prop><D:displayname>renamed</D:displayname></D:prop></D:set>
</D:propertyupdate>`;
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-protected.txt`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(207);
        expect(await res.text()).toContain('HTTP/1.1 403 Forbidden');
    });

    test('PROPPATCH body over 64KB → 413', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-big.txt`, { body: 'x' });
        const body = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test">
  <D:set><D:prop><Z:Big>${'a'.repeat(70_000)}</Z:Big></D:prop></D:set>
</D:propertyupdate>`;
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-big.txt`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(413);
    });

    test('PROPPATCH with a truncated body → 400, nothing persisted', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-trunc.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-trunc.txt`, {
            body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><Z:x xmlns:Z="urn:eigen-test">1</Z:x>',
        });
        expect(res.status).toBe(400);
        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/proppatch-trunc.txt`, {
            headers: { Depth: '0' },
        });
        expect(await find.text()).not.toContain('urn:eigen-test');
    });

    test('PROPPATCH with a name that is not an XML name → 400, later PROPFIND stays well-formed', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-name.txt`, { body: 'a' });
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-name.txt`, {
            body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><Z:a&amp;b xmlns:Z="urn:eigen-test">1</Z:a&amp;b></D:prop></D:set></D:propertyupdate>',
        });
        expect(res.status).toBe(400);
        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/proppatch-name.txt`, {
            headers: { Depth: '0' },
        });
        expect(XMLValidator.validate(await find.text())).toBe(true);
    });
});
