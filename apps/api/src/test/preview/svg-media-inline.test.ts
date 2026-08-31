import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import { eigenMediaHref } from '@workspace/lib/vector';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { getFontFaceCSSForFamilies } from '../../lib/export/fonts';
import { collectExportMedia } from '../../lib/export/media';
import { createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import { inlineSvgMediaRefs, SVG_INLINE_MAX_BYTES } from '../../lib/preview/svg-media-inline';
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

// A <text> element carrying the same escaped family STACK sceneToSvg emits (getFontFamily → escapeXml,
// single quotes become &apos;), so the font detection sees the EIGEN name as a substring of the value.
function svgWithText(fontName: string, text = 'hello'): string {
    const family = getFontFamily(fontName).replace(/'/g, '&apos;');
    return `<svg xmlns="http://www.w3.org/2000/svg"><text font-family="${family}">${text}</text></svg>`;
}

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
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

    test('a crafted sibling mime cannot break out of the href', async () => {
        // mimeType is client-supplied at upload; a type carrying a quote would otherwise escape the
        // attribute. The inliner falls back to a neutral binary type instead of interpolating it.
        const evil = Buffer.from('gif89a-ish');
        await mount.createFile(folderId, 'evil.gif', 'image/gif" onerror="alert(1)', evil.length, evil);
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svgReferencing('evil.gif')))).toString(
            'utf8',
        );
        expect(out).not.toContain('onerror');
        expect(out).toContain(`data:application/octet-stream;base64,${evil.toString('base64')}`);
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

describe('inlineSvgMediaRefs font injection', () => {
    let mount: Mount;
    let folderId: string;
    const dir = join(import.meta.dir, `../../../../../data-test/test-svg-fonts-${Date.now()}`);

    beforeAll(async () => {
        mkdirSync(dir, { recursive: true });
        const config = createDefaultMountConfig('test-svg-fonts', 'local-key');
        mount = new Mount(OWNER_ID, dir, config, createGetLocalDatabase(dir));
        await mount.init();
        folderId = (await mount.getRootFolder())!.id;
    });

    afterAll(() => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {}
    });

    test('an svg whose text names Excalifont gets the face injected as a data: URI', async () => {
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svgWithText('Excalifont')))).toString(
            'utf8',
        );
        expect(out).toContain('<defs><style>');
        expect(out).toContain('font-family: "Excalifont"');
        expect(out).toContain('src: url("data:font/woff2;base64,');
        // The <defs> is spliced right after the opening <svg> tag, before the text.
        expect(out.indexOf('<defs>')).toBeLessThan(out.indexOf('<text'));
    });

    test('only the named family is injected, not every bundled face', async () => {
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svgWithText('Excalifont')))).toString(
            'utf8',
        );
        expect(occurrences(out, '@font-face')).toBe(1);
        expect(out).not.toContain('font-family: "Inter"');
    });

    test('a family whose name merely contains an EIGEN name is not matched', async () => {
        // "Interstate" contains "Inter" — a substring test would wrongly inject the Inter face. Token
        // matching (comma-split, exact) rejects it, so the svg serves byte-identical.
        const svg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Interstate, sans-serif">x</text></svg>',
        );
        const out = await inlineSvgMediaRefs(mount, folderId, svg);
        expect(out.equals(svg)).toBe(true);
        expect(out.toString('utf8')).not.toContain('@font-face');
    });

    test('an svg with no text is returned byte-identical', async () => {
        const plain = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
        const out = await inlineSvgMediaRefs(mount, folderId, plain);
        expect(out.equals(plain)).toBe(true);
    });

    test('an svg whose text names no EIGEN font is returned byte-identical', async () => {
        // font-family present (triggers the scan) but names only a system font — nothing to inject.
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Arial">x</text></svg>');
        const out = await inlineSvgMediaRefs(mount, folderId, svg);
        expect(out.equals(svg)).toBe(true);
    });

    test('an svg already carrying a font-face block is not doubled', async () => {
        const faces = getFontFaceCSSForFamilies(['Excalifont']);
        const fonted = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg"><defs><style>${faces}</style></defs>` +
                `<text font-family="&apos;Excalifont&apos;, cursive">hi</text></svg>`,
        );
        const out = await inlineSvgMediaRefs(mount, folderId, fonted);
        expect(occurrences(out.toString('utf8'), '@font-face')).toBe(1);
        expect(out.equals(fonted)).toBe(true); // no media, faces already present → byte-identical
    });

    test('media inlining and font injection compose in one pass', async () => {
        const pngBytes = Buffer.from(TEST_PNG_BYTES);
        await mount.createFile(folderId, 'pic.png', 'image/png', pngBytes.length, pngBytes);
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg"><image href="${eigenMediaHref('pic.png')}"/>` +
            `<text font-family="&apos;Excalifont&apos;, cursive">hi</text></svg>`;
        const out = (await inlineSvgMediaRefs(mount, folderId, Buffer.from(svg))).toString('utf8');
        expect(out).toContain(`data:image/png;base64,${pngBytes.toString('base64')}`);
        expect(out).toContain('font-family: "Excalifont"');
        expect(out).not.toContain('eigen-media:');
    });

    test('a font-css charge over the byte ceiling degrades to no faces, never throws', async () => {
        // Original sized just under the ceiling so the faces block cannot fit the remaining budget: the
        // font pass degrades (text falls back to a system font) and the svg is still served, unchanged.
        const head = '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="&apos;Excalifont&apos;, cursive">';
        const tail = '</text></svg>';
        const padLen = SVG_INLINE_MAX_BYTES - 500 - head.length - tail.length;
        const svg = Buffer.from(head + 'x'.repeat(padLen) + tail);
        const out = await inlineSvgMediaRefs(mount, folderId, svg);
        expect(out.equals(svg)).toBe(true);
        expect(out.toString('utf8')).not.toContain('@font-face');
    });
});

describe('export media path (prepareMedia + sanitizeExportHtml)', () => {
    let mount: Mount;
    let containerId: string;
    const pngBytes = Buffer.from(TEST_PNG_BYTES);
    const dir = join(import.meta.dir, `../../../../../data-test/test-svg-inline-export-${Date.now()}`);

    beforeAll(async () => {
        mkdirSync(dir, { recursive: true });
        const config = createDefaultMountConfig('test-svg-inline-export', 'local-key');
        mount = new Mount(OWNER_ID, dir, config, createGetLocalDatabase(dir));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        containerId = await mount.createFolder(rootId, 'doc.eigendoc');
        const mediaId = await mount.createFolder(containerId, 'media');
        await mount.createFile(mediaId, 'pic.png', 'image/png', pngBytes.length, pngBytes);
        await mount.createFile(mediaId, 'figure.svg', SVG_MIME, 0, Buffer.from(svgReferencing('pic.png')));
        await mount.createFile(mediaId, 'text.svg', SVG_MIME, 0, Buffer.from(svgWithText('Excalifont')));
        const faces = getFontFaceCSSForFamilies(['Excalifont']);
        await mount.createFile(
            mediaId,
            'fonted.svg',
            SVG_MIME,
            0,
            Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg"><defs><style>${faces}</style></defs>` +
                    `<text font-family="&apos;Excalifont&apos;, cursive">hi</text></svg>`,
            ),
        );
    });

    afterAll(() => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {}
    });

    test('a name-ref svg figure reaches export html as a data: URI', async () => {
        // collectExportMedia runs the real getScreenPreview (inlines) → sanitizeExportHtml (keeps data:
        // hrefs, strips the rest). The exported svg figure must therefore carry the png as a data: URI,
        // not an eigen-media ref WeasyPrint would try to fetch.
        const container = (await mount.getPath(containerId))!;
        const media = await collectExportMedia(mount, container);
        const svg = media.find((item) => item.name === 'figure.svg');
        expect(svg).toBeDefined();
        const html = Buffer.from(svg!.data).toString('utf8');
        expect(html).toContain(`data:image/png;base64,${pngBytes.toString('base64')}`);
        expect(html).not.toContain('eigen-media:');
    });

    test('a text svg figure reaches export html with its @font-face surviving sanitize', async () => {
        // getScreenPreview injects the face; sanitizeExportHtml keeps the <style> and its data: url().
        const container = (await mount.getPath(containerId))!;
        const media = await collectExportMedia(mount, container);
        const html = Buffer.from(media.find((item) => item.name === 'text.svg')!.data).toString('utf8');
        expect(html).toContain('@font-face');
        expect(html).toContain('data:font/woff2;base64,');
    });

    test('an already-fonted svg figure is not double-injected on the export path', async () => {
        // The figure already carries faces (as the vector export produces); the @font-face sniff makes
        // getScreenPreview skip re-injecting, so exactly one block survives.
        const container = (await mount.getPath(containerId))!;
        const media = await collectExportMedia(mount, container);
        const html = Buffer.from(media.find((item) => item.name === 'fonted.svg')!.data).toString('utf8');
        expect(occurrences(html, '@font-face')).toBe(1);
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

    test('a text svg served from the route carries its @font-face under the sandbox CSP', async () => {
        const root = await driveGet(token, ownerId, mountId, 'root');
        const folder = await drivePost(token, ownerId, mountId, `folder/${root.id}`, { folderName: 'text-svg' });
        const svg = new File([svgWithText('Excalifont')], 'labelled.svg', { type: SVG_MIME });
        const uploaded = await driveUpload(token, ownerId, mountId, folder.id, svg);

        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(SVG_MIME);
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        const body = await res.text();
        expect(body).toContain('font-family: "Excalifont"');
        expect(body).toContain('data:font/woff2;base64,');
    });
});
