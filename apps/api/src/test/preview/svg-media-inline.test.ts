import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eigenMediaHref } from '@workspace/lib/vector';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import { inlineSvgMediaRefs } from '../../lib/preview/svg-media-inline';
import { authedRequest, driveGet, drivePost, driveUpload, getTestContext, TEST_PNG_BYTES } from '../setup';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-svg-inline-${Date.now()}`);
const OWNER_ID = 'test-owner-id';
const SVG_MIME = 'image/svg+xml';

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, join(baseDir, relativePath));
        await db.open(0);
        return db;
    };
}

function svgReferencing(...names: string[]): string {
    const images = names.map((name) => `<image href="${eigenMediaHref(name)}"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg">${images}</svg>`;
}

describe('inlineSvgMediaRefs', () => {
    let mount: Mount;
    let folderId: string;
    const pngBytes = Buffer.from(TEST_PNG_BYTES);
    const pngBase64 = pngBytes.toString('base64');

    beforeAll(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        const config = createDefaultMountConfig('test-svg-inline', 'local-key');
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        folderId = await mount.createFolder(rootId, 'media');
        await mount.createFile(folderId, 'pic.png', 'image/png', pngBytes.length, pngBytes);
    });

    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    test('a name-ref resolves to a data: URI with the sibling mime', async () => {
        const svg = svgReferencing('pic.png');
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).toContain(`href="data:image/png;base64,${pngBase64}"`);
        expect(out).not.toContain('eigen-media:');
    });

    test('a no-ref svg is returned byte-identical (cheap sniff, no re-encode)', async () => {
        const plain = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
        const out = await inlineSvgMediaRefs(mount, folderId, plain);
        expect(out.equals(plain)).toBe(true);
    });

    test('a missing sibling has its href stripped and the svg still serves', async () => {
        const svg = svgReferencing('nope.png');
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).not.toContain('eigen-media:');
        expect(out).not.toContain('data:');
        expect(out).toContain('<image/>'); // href gone, element intact
    });

    test('a traversal name is never resolved to a sibling', async () => {
        // `../pic.png` percent-encoded. The codec rejects the `/`, so listEigenMediaRefs drops it —
        // no getChildByName lookup, the token is left untouched (not a data: URI).
        const href = `eigen-media:${encodeURIComponent('../pic.png')}`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${href}"/></svg>`;
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).not.toContain('data:');
        expect(out).toContain(href); // unresolved, unchanged
    });

    test('a sibling svg is inlined recursively', async () => {
        await mount.createFile(folderId, 'inner.svg', SVG_MIME, 0, Buffer.from(svgReferencing('pic.png')));
        const svg = svgReferencing('inner.svg');
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).toContain('data:image/svg+xml;base64,');
        // The nested svg carries the resolved png data URI, so its base64 embeds the png's base64.
        const nested = out.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/);
        expect(nested).not.toBeNull();
        const decoded = Buffer.from(nested![1]!, 'base64').toString('utf8');
        expect(decoded).toContain(`data:image/png;base64,${pngBase64}`);
    });

    test('svg-in-svg recursion is capped, deeper refs stripped', async () => {
        // served(0) -> a(1) -> b(2) -> c(3) -> d(4, stripped). d embeds a unique marker png; with the
        // depth cap of 3, c's ref to d is stripped, so the marker never reaches the output.
        const marker = Buffer.from('DEPTH-CAP-MARKER-BYTES');
        await mount.createFile(folderId, 'marker.png', 'image/png', marker.length, marker);
        await mount.createFile(folderId, 'd.svg', SVG_MIME, 0, Buffer.from(svgReferencing('marker.png')));
        await mount.createFile(folderId, 'c.svg', SVG_MIME, 0, Buffer.from(svgReferencing('d.svg')));
        await mount.createFile(folderId, 'b.svg', SVG_MIME, 0, Buffer.from(svgReferencing('c.svg')));
        await mount.createFile(folderId, 'a.svg', SVG_MIME, 0, Buffer.from(svgReferencing('b.svg')));
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svgReferencing('a.svg')))).toString('utf8');
        expect(out).toContain('data:image/svg+xml;base64,');
        expect(out).not.toContain(marker.toString('base64'));
    });

    test('an output over the byte ceiling degrades to a stripped svg, never throws', async () => {
        // One ~10MB sibling referenced twice inflates past the ~16MB ceiling once base64-encoded, so
        // the pass degrades: every ref stripped, the svg still served.
        const big = Buffer.alloc(10 * 1024 * 1024, 1);
        await mount.createFile(folderId, 'big.bin', 'image/png', big.length, big);
        const svg = svgReferencing('big.bin', 'big.bin');
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).not.toContain('data:');
        expect(out).not.toContain('eigen-media:');
    });
});

describe('svg media inlining over the preview route', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
    });

    test('a name-referencing svg served from a folder inlines the sibling, under the sandbox CSP', async () => {
        const root = await driveGet(token, ownerId, mountId, 'root');
        const folder = await drivePost(token, ownerId, mountId, `folder/${root.id}`, { folderName: 'media' });
        const png = new File([TEST_PNG_BYTES], 'pic.png', { type: 'image/png' });
        await driveUpload(token, ownerId, mountId, folder.id, png);
        const svg = new File([svgReferencing('pic.png')], 'drawing.svg', { type: SVG_MIME });
        const uploaded = await driveUpload(token, ownerId, mountId, folder.id, svg);

        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(SVG_MIME);
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        const body = await res.text();
        expect(body).toContain(`data:image/png;base64,${Buffer.from(TEST_PNG_BYTES).toString('base64')}`);
        expect(body).not.toContain('eigen-media:');
    });
});
