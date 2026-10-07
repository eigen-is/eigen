import { beforeAll, describe, expect, test } from 'bun:test';
import { parseXml, type XmlElement, xmlChild } from '../../lib/core/xml';
import { getSharedDrive } from '../../lib/drive/get-drive';
import { getUserById } from '../../lib/user';
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

    test('PROPPATCH with one refused op saves nothing: 403 for it, 424 for the rest', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-atomic.txt`, { body: 'd' });
        const body = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test">
  <D:set><D:prop><Z:Tag>kept-out</Z:Tag></D:prop></D:set>
  <D:set><D:prop><D:getetag>"forged"</D:getetag></D:prop></D:set>
</D:propertyupdate>`;
        const res = await webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/proppatch-atomic.txt`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toMatch(/<X:Tag [^>]*\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 424 Failed Dependency/);
        expect(xml).toMatch(/<D:getetag\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 403 Forbidden/);
        expect(xml).not.toContain('200 OK');

        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/proppatch-atomic.txt`, {
            headers: { Depth: '0' },
        });
        expect(await find.text()).not.toContain('kept-out');
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

    test('dead properties past 64KB on one path → 507, nothing persisted', async () => {
        const url = `${baseHref}/proppatch-full.txt`;
        await webdavRequest(ctx.alice.user.email, 'PUT', url, { body: 'x' });
        const setProp = (name: string) =>
            webdavRequest(ctx.alice.user.email, 'PROPPATCH', url, {
                body: `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test">
  <D:set><D:prop><Z:${name}>${'a'.repeat(40_000)}</Z:${name}></D:prop></D:set>
</D:propertyupdate>`,
                headers: { 'Content-Type': 'application/xml; charset=utf-8' },
            });
        expect((await setProp('First')).status).toBe(207);
        expect((await setProp('Second')).status).toBe(507);

        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', url, { headers: { Depth: '0' } });
        const xml = await find.text();
        expect(xml).toContain('First');
        expect(xml).not.toContain('Second');
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
        expect(parseXml(await find.text())).not.toBeNull();
    });

    const proppatch = (name: string, body: BodyInit) =>
        webdavRequest(ctx.alice.user.email, 'PROPPATCH', `${baseHref}/${name}`, {
            body,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });

    // The one row's 200 prop, read as XML so a test sees elements and namespaces rather than bytes.
    async function deadProp(name: string, local: string, ns = 'urn:eigen-test'): Promise<XmlElement | undefined> {
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/${name}`, {
            headers: { Depth: '0' },
        });
        const multistatus = parseXml(await res.text());
        const row = multistatus && xmlChild(multistatus, 'DAV:', 'response');
        const propstat = row && xmlChild(row, 'DAV:', 'propstat');
        const prop = propstat && xmlChild(propstat, 'DAV:', 'prop');
        return prop ? xmlChild(prop, ns, local) : undefined;
    }

    test('a dead property in no namespace stays in no namespace, never DAV:', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-no-ns.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-no-ns.txt',
            '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><Tag>kept</Tag></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(parseXml(xml)).not.toBeNull();
        expect(xml).toMatch(/<Tag xmlns=""\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        expect((await deadProp('proppatch-no-ns.txt', 'Tag', ''))?.children).toEqual(['kept']);
    });

    test('a prop in no namespace named like a live one is refused as the live one is', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-no-ns-live.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-no-ns-live.txt',
            '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><getetag>forged</getetag></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        expect(await res.text()).toMatch(/<getetag xmlns=""\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 403 Forbidden/);
        expect(await deadProp('proppatch-no-ns-live.txt', 'getetag', '')).toBeUndefined();
    });

    test('a prop in no namespace named like a live one, stored before the refusal, can still be removed', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-no-ns-stuck.txt`, { body: 'a' });
        const user = await getUserById(ctx.alice.user.id);
        const drive = await getSharedDrive(ctx.alice.user.id, user!);
        const path = await drive.resolvePath(mountId, '/proppatch-no-ns-stuck.txt');
        await drive.updatePathDetails(mountId, path!.id, {
            ...(path!.details ?? {}),
            webdavProps: [{ ns: '', name: 'getetag', value: 'stale' }],
        });
        expect((await deadProp('proppatch-no-ns-stuck.txt', 'getetag', ''))?.children).toEqual(['stale']);

        const res = await proppatch(
            'proppatch-no-ns-stuck.txt',
            '<D:propertyupdate xmlns:D="DAV:"><D:remove><D:prop><getetag/></D:prop></D:remove></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        expect(await res.text()).toMatch(/<getetag xmlns=""\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        expect(await deadProp('proppatch-no-ns-stuck.txt', 'getetag', '')).toBeUndefined();
    });

    test('a prop in the xml namespace is refused, and the PROPPATCH answer and its folder stay well-formed', async () => {
        await webdavRequest(ctx.alice.user.email, 'MKCOL', `${baseHref}/proppatch-xml-ns`);
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-xml-ns/f.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-xml-ns/f.txt',
            '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><xml:tag>red</xml:tag></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(parseXml(xml)).not.toBeNull();
        expect(xml).toMatch(/<xml:tag\/>\s*<\/D:prop>\s*<D:status>HTTP\/1.1 403 Forbidden/);

        const find = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `${baseHref}/proppatch-xml-ns/`, {
            headers: { Depth: '1' },
        });
        expect(find.status).toBe(207);
        const listing = await find.text();
        expect(parseXml(listing)).not.toBeNull();
        expect(listing).not.toContain('>red<');
    });

    test('PROPPATCH whose root is not DAV:propertyupdate → 400, nothing persisted', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-root.txt`, { body: 'a' });
        for (const body of [
            '<propertyupdate><set><prop><Z:x xmlns:Z="urn:eigen-test">1</Z:x></prop></set></propertyupdate>',
            '<F:propertyupdate xmlns:F="urn:foreign" xmlns:D="DAV:"><D:set><D:prop><Z:x xmlns:Z="urn:eigen-test">1</Z:x></D:prop></D:set></F:propertyupdate>',
        ]) {
            expect((await proppatch('proppatch-root.txt', body)).status).toBe(400);
        }
        expect(await deadProp('proppatch-root.txt', 'x')).toBeUndefined();
    });

    test('PROPPATCH runs set, remove, set in document order: the last set stays', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-order.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-order.txt',
            '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:p>one</Z:p></D:prop></D:set><D:remove><D:prop><Z:p/></D:prop></D:remove><D:set><D:prop><Z:p>two</Z:p></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        expect((await deadProp('proppatch-order.txt', 'p'))?.children).toEqual(['two']);
    });

    test('a dead property with element content comes back as elements in their namespace', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-mixed.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-mixed.txt',
            '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:a>pre<Z:b>1</Z:b>post</Z:a></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        const [pre, b, post] = (await deadProp('proppatch-mixed.txt', 'a'))?.children ?? [];
        expect(pre).toBe('pre');
        expect(b).toMatchObject({ ns: 'urn:eigen-test', local: 'b', children: ['1'] });
        expect(post).toBe('post');
    });

    test('a text dead property keeps markup characters as text', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-text.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-text.txt',
            '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:t>&lt;b&gt;</Z:t></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        expect((await deadProp('proppatch-text.txt', 't'))?.children).toEqual(['<b>']);
    });

    test('element content under a DAV: dead prop keeps its own D prefix binding', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-dav-xml.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-dav-xml.txt',
            '<x:propertyupdate xmlns:x="DAV:" xmlns:D="urn:not-dav"><x:set><x:prop><x:myprop><D:href>h</D:href></x:myprop></x:prop></x:set></x:propertyupdate>',
        );
        expect(res.status).toBe(207);
        const [href] = (await deadProp('proppatch-dav-xml.txt', 'myprop', 'DAV:'))?.children ?? [];
        expect(href).toMatchObject({ ns: 'urn:not-dav', local: 'href', children: ['h'] });
    });

    test('unprefixed children keep their namespace, the inherited default or none', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-unprefixed.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-unprefixed.txt',
            '<D:propertyupdate xmlns:D="DAV:" xmlns="urn:default" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:p><a>1</a><b xmlns="">2</b></Z:p></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(207);
        const [a, b] = (await deadProp('proppatch-unprefixed.txt', 'p'))?.children ?? [];
        expect(a).toMatchObject({ ns: 'urn:default', local: 'a', children: ['1'] });
        expect(b).toMatchObject({ ns: '', local: 'b', children: ['2'] });
    });

    test('PROPPATCH with a DOCTYPE → 400, nothing persisted', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-doctype.txt`, { body: 'a' });
        const res = await proppatch(
            'proppatch-doctype.txt',
            '<?xml version="1.0"?><!DOCTYPE D:propertyupdate [<!ENTITY e "x">]><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:x>&e;</Z:x></D:prop></D:set></D:propertyupdate>',
        );
        expect(res.status).toBe(400);
        expect(await deadProp('proppatch-doctype.txt', 'x')).toBeUndefined();
    });

    test('PROPPATCH in UTF-16 with a BOM is read', async () => {
        await webdavRequest(ctx.alice.user.email, 'PUT', `${baseHref}/proppatch-utf16.txt`, { body: 'a' });
        const xml =
            '<?xml version="1.0" encoding="UTF-16"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:eigen-test"><D:set><D:prop><Z:u>één</Z:u></D:prop></D:set></D:propertyupdate>';
        const bytes = new Uint8Array(Buffer.from(`﻿${xml}`, 'utf16le'));
        expect((await proppatch('proppatch-utf16.txt', bytes)).status).toBe(207);
        expect((await deadProp('proppatch-utf16.txt', 'u'))?.children).toEqual(['één']);
    });
});
