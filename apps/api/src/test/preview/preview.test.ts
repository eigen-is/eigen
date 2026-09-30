import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import { VCARD_MAX_BYTES } from '@workspace/lib/constants/contact';
import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { TEXT_PREVIEW_MAX_BYTES } from '@workspace/lib/constants/preview';
import { DRIVE_MIME_SLIDES, EML_MIME, ICS_MIME } from '@workspace/lib/types/drive';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { getHome } from '../../lib/home/get-home';
import { Mount } from '../../lib/mount/mount';
import { isExiftoolCandidate } from '../../lib/preview/exiftool-preview';
import { EML_FORMAT, getTextPreview, ICS_FORMAT, TEXT_FORMAT, VCARD_FORMAT } from '../../lib/preview/preview-cache';
import { isVideoCandidate } from '../../lib/preview/video-preview';
import { generateImagePreview, saveThumbnail } from '../../lib/shared/thumbnails';
import {
    buildGoldenVectorScene,
    GOLDEN_MEDIA_NAME,
    seedDocumentMedia,
    seedVectorDoc,
} from '../fixtures/golden-documents';
import { createTestMountConfig } from '../mount-test-helpers';
import { authedRequest, driveGet, drivePost, driveUpload, getTestContext, TEST_PNG_BYTES } from '../setup';

describe('Preview', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    async function uploadAndTextPreview(name: string, content: string, mimeType: string) {
        const file = new File([content], name, { type: mimeType });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/text-preview`);
        return { res, uploaded };
    }

    test('text file returns json body preview', async () => {
        const { res } = await uploadAndTextPreview('test.txt', 'Hello world', 'text/plain');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.body).toContain('Hello world');
        expect(data.mode).toBe('plaintext');
    });

    // It answers under its own route instead — a raw body is mostly base64 photo.
    test('a vcard has no text preview — it answers under its own route instead', async () => {
        const content = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nEND:VCARD\r\n';
        const { res } = await uploadAndTextPreview('no-text.vcf', content, 'text/vcard');
        expect(res.status).toBe(404);
    });

    test('plaintext preview renders prose paragraphs, not a code block', async () => {
        const content = 'First line\nsecond line\n\nSecond paragraph with <b>markup</b>';
        const { res } = await uploadAndTextPreview('para.txt', content, 'text/plain');
        expect(res.status).toBe(200);
        const data = await res.json();
        // eigen-prose paints every <pre> as a dark non-wrapping code block — .txt must read
        // like rendered markdown instead: paragraphs on blank lines, <br> on single newlines.
        expect(data.body).not.toContain('<pre>');
        expect(data.body).toContain('<p>First line<br>second line</p>');
        expect(data.body).toContain('<p>Second paragraph with &lt;b&gt;markup&lt;/b&gt;</p>');
    });

    test('markdown file returns rendered body', async () => {
        const { res } = await uploadAndTextPreview('test.md', '# Title\n\nSome **bold** text', 'text/markdown');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.body).toContain('<h1>Title</h1>');
        expect(data.body).toContain('<strong>bold</strong>');
        expect(data.mode).toBe('markdown');
    });

    test('markdown remote image cannot beacon a viewer', async () => {
        // The body renders as live DOM in the drive hero, so a `.md` image pointing at a
        // remote URL must not survive into an <img src> that fetches on every view.
        const content = 'Look here: ![x](http://evil.example/beacon)\n\nreadable text';
        const { res } = await uploadAndTextPreview('beacon.md', content, 'text/markdown');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.body).toContain('readable text');
        expect(data.body).not.toContain('http://evil.example');
    });

    test('code file returns syntax highlighted body', async () => {
        const { res } = await uploadAndTextPreview('test.json', '{"key": "value"}', 'application/json');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.body).toContain('key');
        expect(data.mode).toBe('code');
    });

    test('image file returns webp preview', async () => {
        const file = new File([TEST_PNG_BYTES], 'pixel.png', { type: 'image/png' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        // Rasterised previews carry no sandbox CSP — it exists only for the scriptable SVG case.
        expect(res.headers.get('content-security-policy')).toBeNull();
    });

    test('svg preview is served as-is under a sandbox CSP', async () => {
        // Served raw (no rasterisation) and rendered inline on the API origin, so a scriptable
        // upload must get the same sandbox CSP as /embed (serve-file.ts).
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
        const file = new File([svg], 'evil.svg', { type: 'image/svg+xml' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml');
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await res.text()).toBe(svg);
    });

    test('video file redirects to embed', async () => {
        const file = new File(['fake video'], 'clip.mp4', { type: 'video/mp4' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        // Elysia redirect — check for 302 or the redirect URL in headers
        expect([200, 302]).toContain(res.status);
    });

    test('unsupported file type returns 404', async () => {
        // Upload a file that has no preview support (non-image, non-text, non-video)
        const file = new File(['dummy'], 'data.woff2', { type: 'font/woff2' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(404);
    });

    test('text file preview returns 404 from image preview endpoint', async () => {
        const file = new File(['Hello'], 'check.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(res.status).toBe(404);
    });

    test('nonexistent file returns 404', async () => {
        const res = await authedRequest(
            token,
            `/drive/${ownerId}/${mountId}/file/00000000-0000-0000-0000-000000000000/preview`,
        );
        expect(res.status).toBe(404);
    });

    test('text preview caches result on second request', async () => {
        const { res: first, uploaded } = await uploadAndTextPreview('cached.txt', 'Cache test', 'text/plain');
        expect(first.status).toBe(200);

        const second = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/text-preview`);
        expect(second.status).toBe(200);
        const data = await second.json();
        expect(data.body).toContain('Cache test');
    });

    test('image preview is cached on second request', async () => {
        const file = new File([TEST_PNG_BYTES], 'cached.png', { type: 'image/png' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        const first = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(first.status).toBe(200);

        const second = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(second.status).toBe(200);
        expect(second.headers.get('content-type')).toBe('image/webp');
    });

    test('upload image generates thumbnail', async () => {
        const file = new File([TEST_PNG_BYTES], 'thumb-test.png', { type: 'image/png' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        // Thumbnail is generated in the background — poll for it
        let path = uploaded;
        for (let i = 0; i < 20 && !path.thumbnail; i++) {
            await Bun.sleep(50);
            const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/path/${uploaded.id}`);
            path = await res.json();
        }
        expect(path.thumbnail).toBeTruthy();
    });

    test('upload video generates thumbnail with duration', async () => {
        const { isFfmpegAvailable } = await import('../../lib/shared/video-thumbnail');
        if (!(await isFfmpegAvailable())) {
            console.warn('Skipping: ffmpeg not installed');
            return;
        }

        const fs = await import('node:fs/promises');
        const fixturePath = `${import.meta.dir}/../fixtures/tiny-video.mp4`;
        const bytes = await fs.readFile(fixturePath);
        const file = new File([new Uint8Array(bytes)], 'clip.mp4', { type: 'video/mp4' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        // Thumbnail is generated in the background — poll for it.
        // Budget 4s (vs 1s for image): ffmpeg subprocess is slower than in-process sharp.
        let path = uploaded;
        for (let i = 0; i < 40 && !path.thumbnail; i++) {
            await Bun.sleep(100);
            const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/path/${uploaded.id}`);
            path = await res.json();
        }

        expect(path.thumbnail).toBe(`${uploaded.id}.webp`);
        expect(path.details).not.toBeNull();
        expect(path.details!.width).toBe(160);
        expect(path.details!.height).toBe(120);
        expect(path.details!.duration).toBeGreaterThan(1.9);
        expect(path.details!.duration).toBeLessThan(2.5);

        // Thumb endpoint serves the webp.
        const thumbRes = await authedRequest(token, `/drive/${ownerId}/${mountId}/thumb/${uploaded.id}.webp`);
        expect(thumbRes.status).toBe(200);
        expect(thumbRes.headers.get('content-type')).toBe('image/webp');
    });
});

describe('generateImagePreview', () => {
    const tmpDir = mkdtempSync('/tmp/eigen-preview-test-');

    async function writeTempFile(name: string, data: Buffer): Promise<string> {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(tmpDir, { recursive: true });
        const filePath = `${tmpDir}/${name}`;
        await Bun.write(filePath, data);
        return filePath;
    }

    test('converts PNG file to WebP and returns dimensions', async () => {
        const pngBytes = Buffer.from(TEST_PNG_BYTES);
        const filePath = await writeTempFile('test.png', pngBytes);
        const result = await generateImagePreview(filePath, 'image/png', 'test.png', tmpDir, 'test-png');
        expect(result).not.toBeNull();
        expect(result!.width).toBe(4);
        expect(result!.height).toBe(4);
        // WebP magic bytes: RIFF....WEBP
        expect(result!.data[0]).toBe(0x52); // R
        expect(result!.data[1]).toBe(0x49); // I
        expect(result!.data[2]).toBe(0x46); // F
        expect(result!.data[3]).toBe(0x46); // F
    });

    test('returns null for non-image mime', async () => {
        const filePath = await writeTempFile('file.txt', Buffer.from('not an image'));
        const result = await generateImagePreview(filePath, 'text/plain', 'file.txt', tmpDir, 'test-txt');
        expect(result).toBeNull();
    });

    test('returns null for corrupt image data', async () => {
        const filePath = await writeTempFile('bad.png', Buffer.from('not valid png data'));
        const result = await generateImagePreview(filePath, 'image/png', 'bad.png', tmpDir, 'test-bad');
        expect(result).toBeNull();
    });

    test('JPEG file produces WebP output', async () => {
        const sharp = (await import('sharp')).default;
        const jpegBuf = await sharp({
            create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 128, b: 255 } },
        })
            .jpeg()
            .toBuffer();

        const filePath = await writeTempFile('test.jpg', jpegBuf);
        const result = await generateImagePreview(filePath, 'image/jpeg', 'test.jpg', tmpDir, 'test-jpg');
        expect(result).not.toBeNull();
        expect(result!.data[0]).toBe(0x52); // RIFF
    });

    test('respects maxSize option', async () => {
        const sharp = (await import('sharp')).default;
        const largePng = await sharp({
            create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
        })
            .png()
            .toBuffer();

        const filePath = await writeTempFile('large.png', largePng);
        const result = await generateImagePreview(filePath, 'image/png', 'large.png', tmpDir, 'test-large', {
            maxSize: 32,
        });
        expect(result).not.toBeNull();
        expect(result!.width).toBe(100);
        expect(result!.height).toBe(100);

        const meta = await sharp(result!.data).metadata();
        expect(meta.width).toBeLessThanOrEqual(32);
        expect(meta.height).toBeLessThanOrEqual(32);
    });
});

describe('isVideoCandidate', () => {
    test('video/* MIME types are candidates', () => {
        expect(isVideoCandidate('video/mp4')).toBe(true);
        expect(isVideoCandidate('video/quicktime')).toBe(true);
        expect(isVideoCandidate('video/webm')).toBe(true);
        expect(isVideoCandidate('video/x-matroska')).toBe(true);
    });

    test('non-video MIME types are not candidates', () => {
        expect(isVideoCandidate('image/png')).toBe(false);
        expect(isVideoCandidate('application/pdf')).toBe(false);
        expect(isVideoCandidate('text/plain')).toBe(false);
        expect(isVideoCandidate('')).toBe(false);
    });
});

describe('saveThumbnail (video)', () => {
    const fixtureDir = `${import.meta.dir}/../fixtures`;
    const thumbsDir = mkdtempSync('/tmp/eigen-video-thumbs-test-');

    test('generates a webp thumbnail for an mp4', async () => {
        const { isFfmpegAvailable } = await import('../../lib/shared/video-thumbnail');
        if (!(await isFfmpegAvailable())) {
            console.warn('Skipping: ffmpeg not installed');
            return;
        }

        const result = await saveThumbnail(
            thumbsDir,
            'video-test-pathid',
            `${fixtureDir}/tiny-video.mp4`,
            'video/mp4',
            'tiny-video.mp4',
        );

        expect(result).not.toBeNull();
        expect(result!.fileName).toBe('video-test-pathid.webp');
        expect(result!.width).toBe(160);
        expect(result!.height).toBe(120);
        expect(result!.duration).toBeGreaterThan(1.9);
        expect(result!.duration).toBeLessThan(2.5);

        const file = Bun.file(`${thumbsDir}/video-test-pathid.webp`);
        expect(await file.exists()).toBe(true);
        const bytes = new Uint8Array(await file.arrayBuffer());
        // WebP magic: RIFF....WEBP
        expect(bytes[0]).toBe(0x52); // R
        expect(bytes[1]).toBe(0x49); // I
        expect(bytes[2]).toBe(0x46); // F
        expect(bytes[3]).toBe(0x46); // F
    });
});

describe('isExiftoolCandidate', () => {
    test('standard image mimes are candidates', () => {
        expect(isExiftoolCandidate('image/png', 'test.png')).toBe(true);
        expect(isExiftoolCandidate('image/jpeg', 'test.jpg')).toBe(true);
        expect(isExiftoolCandidate('image/webp', 'test.webp')).toBe(true);
        expect(isExiftoolCandidate('image/heic', 'test.heic')).toBe(true);
        expect(isExiftoolCandidate('image/vnd.adobe.photoshop', 'test.psd')).toBe(true);
    });

    test('exiftool extensions are candidates even with non-image mime', () => {
        expect(isExiftoolCandidate('application/photoshop', 'test.psd')).toBe(true);
        expect(isExiftoolCandidate('application/octet-stream', 'photo.cr2')).toBe(true);
        expect(isExiftoolCandidate('application/octet-stream', 'photo.heic')).toBe(true);
    });

    test('non-image types without exiftool extensions are not candidates', () => {
        expect(isExiftoolCandidate('text/plain', 'file.txt')).toBe(false);
        expect(isExiftoolCandidate('video/mp4', 'clip.mp4')).toBe(false);
        expect(isExiftoolCandidate('font/woff2', 'font.woff2')).toBe(false);
        expect(isExiftoolCandidate('application/pdf', 'doc.pdf')).toBe(false);
    });
});

describe('pruneOldVersions', () => {
    test('removes prior versions of a path, keeps the current file and other paths', async () => {
        const { pruneOldVersions } = await import('../../lib/preview/preview-cache');
        const { existsSync, mkdirSync } = await import('node:fs');

        const dir = mkdtempSync('/tmp/eigen-prune-test-');
        mkdirSync(dir, { recursive: true });

        // pathIds are UUIDs (contain dashes) — the prefix match must not bleed across paths.
        const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        const other = '00000000-0000-0000-0000-000000000000';
        const keep = `${id}-200.json`;

        await Bun.write(`${dir}/${id}-100.json`, '{}'); // older text version
        await Bun.write(`${dir}/${id}-150.screen.webp`, 'x'); // older image version
        await Bun.write(`${dir}/${keep}`, '{}'); // current version
        await Bun.write(`${dir}/${other}-100.json`, '{}'); // a different path

        await pruneOldVersions(dir, id, keep);

        expect(existsSync(`${dir}/${id}-100.json`)).toBe(false);
        expect(existsSync(`${dir}/${id}-150.screen.webp`)).toBe(false);
        expect(existsSync(`${dir}/${keep}`)).toBe(true);
        expect(existsSync(`${dir}/${other}-100.json`)).toBe(true);
    });
});

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, `${baseDir}/${relativePath}`);
        await db.open(0);
        return db;
    };
}

describe('getTextPreview (stale-while-revalidate)', () => {
    test('serves the prior version while the current one regenerates, then converges on it', async () => {
        const { mkdirSync } = await import('node:fs');
        const tmpDir = mkdtempSync('/tmp/eigen-stale-preview-test-');
        mkdirSync(tmpDir, { recursive: true });

        const config = createTestMountConfig('test-stale-preview', 'local-key');
        const mount = new Mount('test-owner-id', tmpDir, config, createGetLocalDatabase(tmpDir));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const v1 = Buffer.from('version one');
        const fileId = await mount.createFile(rootId, 'notes.txt', 'text/plain', v1.length, v1);
        const path = await mount.getActivePath(fileId);

        // Nothing cached yet — the first request generates the current version synchronously.
        const first = await getTextPreview(mount, { ...path, updatedAt: new Date(1000) });
        expect(first?.stale).toBe(false);
        expect(first?.value.body).toContain('version one');

        // Edit: new content under a newer updatedAt. Cache names are content-addressed by updatedAt,
        // so the current version is now a miss while the prior one becomes a stale candidate.
        await mount.writeFile(fileId, Buffer.from('version two'));
        const edited = { ...path, updatedAt: new Date(2000) };

        // The request serves the prior version immediately (the route marks it no-store) and kicks
        // off a single background regeneration of the current one.
        const stale = await getTextPreview(mount, edited);
        expect(stale?.stale).toBe(true);
        expect(stale?.value.body).toContain('version one');

        // Background regeneration lands the fresh version; subsequent requests return it as current.
        let fresh = await getTextPreview(mount, edited);
        for (let i = 0; i < 40 && fresh?.stale !== false; i++) {
            await Bun.sleep(25);
            fresh = await getTextPreview(mount, edited);
        }
        expect(fresh?.stale).toBe(false);
        expect(fresh?.value.body).toContain('version two');
    });

    test('a body a previous renderer version cached is never served stale', async () => {
        // TEXT_FORMAT names the shape the CURRENT consumers scale and lay out. Serving a prior
        // format's body would hand every post-deploy reader of an untouched document a body its
        // own CSS mis-sizes, until an edit finally regenerated it.
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const tmpDir = mkdtempSync('/tmp/eigen-stale-format-test-');
        mkdirSync(tmpDir, { recursive: true });

        const config = createTestMountConfig('test-stale-format', 'local-key');
        const mount = new Mount('test-owner-id', tmpDir, config, createGetLocalDatabase(tmpDir));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const bytes = Buffer.from('current content');
        const fileId = await mount.createFile(rootId, 'notes.txt', 'text/plain', bytes.length, bytes);
        const path = await mount.getActivePath(fileId);

        mkdirSync(mount.previewsDir, { recursive: true });
        writeFileSync(
            `${mount.previewsDir}/${fileId}-1000.f4.json`,
            JSON.stringify({ mode: 'text', body: 'a body of the previous shape' }),
        );

        const served = await getTextPreview(mount, { ...path, updatedAt: new Date(2000) });
        expect(served?.stale).toBe(false);
        expect(served?.value.body).toContain('current content');
    });

    test('a file past the preview ceiling has no preview, and its bytes are never read', async () => {
        const { mkdirSync } = await import('node:fs');
        const tmpDir = mkdtempSync('/tmp/eigen-oversize-text-test-');
        mkdirSync(tmpDir, { recursive: true });

        const config = createTestMountConfig('test-oversize-text', 'local-key');
        const mount = new Mount('test-owner-id', tmpDir, config, createGetLocalDatabase(tmpDir));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const bytes = Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 'x');
        const fileId = await mount.createFile(rootId, 'huge.txt', 'text/plain', bytes.length, bytes);
        const path = await mount.getActivePath(fileId);

        // The row's size decides, so the decode and the highlighter are spared the read as well.
        const readFile = spyOn(mount, 'readFile');
        expect(await getTextPreview(mount, path)).toBeNull();
        expect(readFile).not.toHaveBeenCalled();
        readFile.mockRestore();
    });

    test('an uploaded file wearing a collab mime still previews as the file it is', async () => {
        // mimeType is caller-controlled on upload; only the CONTAINER type says a path is a collab
        // document. Dispatching on the mime alone sent a plain text file into the Yjs preview path,
        // where it fails and loses the plaintext preview it should have had.
        const { mkdirSync } = await import('node:fs');
        const tmpDir = mkdtempSync('/tmp/eigen-mime-spoof-test-');
        mkdirSync(tmpDir, { recursive: true });

        const config = createTestMountConfig('test-mime-spoof', 'local-key');
        const mount = new Mount('test-owner-id', tmpDir, config, createGetLocalDatabase(tmpDir));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const bytes = Buffer.from('plain text pretending to be a deck');
        const fileId = await mount.createFile(rootId, 'deck.txt', 'text/plain', bytes.length, bytes);
        const path = await mount.getActivePath(fileId);

        const served = await getTextPreview(mount, { ...path, mimeType: DRIVE_MIME_SLIDES });
        expect(served?.value.body).toContain('plain text pretending to be a deck');
        // And it is labelled as what it is: the deck mode would draw this body inside a slide frame.
        expect(served?.value.mode).toBe('plaintext');
    });
});

// A .vcf previews as the contact cards it holds, served as JSON the overlay and the drive hero render
// (PREVIEWS.md). The parse itself is covered in vcard-preview.test.ts; this pins what the route answers.
describe('vCard preview route', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    async function uploadVCard(name: string, content: string) {
        const file = new File([content], name, { type: 'text/vcard' });
        return await driveUpload(token, ownerId, mountId, rootId, file);
    }

    // The birthday is served as the date-only string it is on the card: the client reads this route
    // through the no-revival treaty, and a Date here would reach ContactDetailCard's formatDateOnly.
    test('serves the cards a file holds, with their categories and a date-only birthday', async () => {
        const content =
            'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nEMAIL:jane@example.com\r\nBDAY:1984-03-21\r\nCATEGORIES:Work\r\nEND:VCARD\r\n';
        const uploaded = await uploadVCard('team.vcf', content);

        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/vcard-preview`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({
            cards: [
                {
                    contact: {
                        id: '',
                        etag: '',
                        firstName: 'Jane',
                        lastName: 'Doe',
                        email: ['jane@example.com'],
                        phone: [],
                        company: '',
                        jobTitle: '',
                        address: [],
                        birthday: '1984-03-21',
                        notes: '',
                        labels: [],
                    },
                    categories: ['Work'],
                },
            ],
            dropped: 0,
            total: 1,
        });
    });

    test('a file over the import ceiling is refused before its bytes are read', async () => {
        // The stored size is what the route admits on, so a small file claiming a large one still 413s.
        const bytes = Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nEND:VCARD\r\n');
        const seed = await uploadVCard('seed-for-mount.vcf', bytes.toString());
        const home = await getHome(ownerId);
        const { mount } = await home.drive.resolveFile(mountId, seed.id);
        const hugeId = await mount.createFile(rootId, 'huge.vcf', 'text/vcard', VCARD_MAX_BYTES + 1, bytes);

        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${hugeId}/vcard-preview`);
        expect(res.status).toBe(413);
    });

    // A cached file can be half-written or truncated on disk. Serving a 500 for it would be permanent:
    // it is the CURRENT version, so nothing would ever regenerate it.
    test('a truncated cached payload is regenerated, not served as an error', async () => {
        const content = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Roe;Richard;;;\r\nFN:Richard Roe\r\nEND:VCARD\r\n';
        const uploaded = await uploadVCard('corrupt-cache.vcf', content);
        const url = `/drive/${ownerId}/${mountId}/file/${uploaded.id}/vcard-preview`;
        expect((await authedRequest(token, url)).status).toBe(200);

        const home = await getHome(ownerId);
        const { mount } = await home.drive.resolveFile(mountId, uploaded.id);
        const cached = readdirSync(mount.previewsDir).find((name) => name.startsWith(`${uploaded.id}-`));
        writeFileSync(`${mount.previewsDir}/${cached}`, JSON.stringify({ body: '{"cards":[{"contact":' }));

        const res = await authedRequest(token, url);
        expect(res.status).toBe(200);
        expect((await res.json()).cards[0].contact.firstName).toBe('Richard');
    });

    test('a file that is not a vCard is refused outright', async () => {
        const file = new File(['ford prefect'], 'notes.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/vcard-preview`);
        expect(res.status).toBe(400);
    });
});

// An .eml previews as the message it holds, served as JSON the overlay renders (PREVIEWS.md). The parse
// and the sanitizer are covered in eml-preview.test.ts; this pins what the route answers.
describe('eml preview route', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    const MESSAGE = [
        'From: Ada Lovelace <ada@external.com>',
        'To: alice@example.com',
        'Subject: Engine notes',
        'Date: Tue, 15 Aug 2026 10:30:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>The engine <img src="https://tracker.example/pixel.png"> weaves patterns.</p>',
        '',
    ].join('\r\n');

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    async function uploadEml(name: string, content: string) {
        const file = new File([content], name, { type: EML_MIME });
        return await driveUpload(token, ownerId, mountId, rootId, file);
    }

    const previewUrl = (pathId: string) => `/drive/${ownerId}/${mountId}/file/${pathId}/eml-preview`;

    test('serves the message headers and a body that fetches nothing', async () => {
        const uploaded = await uploadEml('notes.eml', MESSAGE);

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        const data = await res.json();
        expect(data.subject).toBe('Engine notes');
        expect(data.from.value[0].address).toBe('ada@external.com');
        // A date-shaped string, not a Date: the route is read through the no-revival treaty.
        expect(data.date).toBe('2026-08-15T10:30:00.000Z');
        expect(data.html).toContain('weaves patterns');
        expect(data.html).not.toContain('tracker.example');
        expect(data.attachments).toEqual([]);
    });

    test('a file over the ceiling is refused before its bytes are read', async () => {
        // The stored size is what the route admits on, so a small file claiming a large one still 413s.
        const bytes = Buffer.from(MESSAGE);
        const seed = await uploadEml('seed-for-eml-mount.eml', MESSAGE);
        const home = await getHome(ownerId);
        const { mount } = await home.drive.resolveFile(mountId, seed.id);
        const hugeId = await mount.createFile(rootId, 'huge.eml', EML_MIME, EML_MAX_BYTES + 1, bytes);

        const res = await authedRequest(token, previewUrl(hugeId));
        expect(res.status).toBe(413);
    });

    test('a file that is not a message is refused outright', async () => {
        const file = new File(['ford prefect'], 'notes.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(400);
    });

    test('a file the parser refuses answers 422, never a crash', async () => {
        const boundary = 'too-many-parts';
        const garbage = [
            'Content-Type: multipart/mixed; boundary="too-many-parts"',
            '',
            `--${boundary}\r\n`.repeat(1001),
            `--${boundary}--`,
        ].join('\r\n');

        const uploaded = await uploadEml('garbage.eml', garbage);

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(422);
    });

    test('a file the caller cannot read is not previewed', async () => {
        const uploaded = await uploadEml('private.eml', MESSAGE);
        const ctx = await getTestContext();

        const res = await authedRequest(ctx.bob.user.sessionToken, previewUrl(uploaded.id));
        expect(res.status).toBe(403);
    });
});

// An .ics previews as the events it holds, served as JSON the overlay renders (PREVIEWS.md). The parse
// is covered in ics-preview.test.ts; this pins what the route answers.
describe('ics preview route', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    const CALENDAR = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Eigen//Test//EN',
        'BEGIN:VEVENT',
        'UID:festival@eigen',
        'DTSTART;VALUE=DATE:20260920',
        'DTEND;VALUE=DATE:20260922',
        'SUMMARY:Harvest festival',
        'LOCATION:Market square',
        'ATTACH:https://tracker.example/agenda.pdf',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
    ].join('\r\n');

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    async function uploadIcs(name: string, content: string) {
        const file = new File([content], name, { type: ICS_MIME });
        return await driveUpload(token, ownerId, mountId, rootId, file);
    }

    const previewUrl = (pathId: string) => `/drive/${ownerId}/${mountId}/file/${pathId}/ics-preview`;

    test('serves the events a calendar holds, with bare dates for an all-day one', async () => {
        const uploaded = await uploadIcs('festival.ics', CALENDAR);

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        const data = await res.json();
        expect(data.total).toBe(1);
        expect(data.dropped).toBe(0);
        expect(data.events[0]).toMatchObject({
            uid: 'festival@eigen',
            title: 'Harvest festival',
            location: 'Market square',
            // Date-shaped strings, not Dates: the route is read through the no-revival treaty.
            start: '2026-09-20',
            end: '2026-09-22',
            allDay: true,
        });
        // Nothing the file points at rides along, so the card fetches nothing.
        expect(JSON.stringify(data)).not.toContain('tracker.example');
    });

    test('a file over the ceiling is refused before its bytes are read', async () => {
        // The stored size is what the route admits on, so a small file claiming a large one still 413s.
        const bytes = Buffer.from(CALENDAR);
        const seed = await uploadIcs('seed-for-ics-mount.ics', CALENDAR);
        const home = await getHome(ownerId);
        const { mount } = await home.drive.resolveFile(mountId, seed.id);
        const hugeId = await mount.createFile(rootId, 'huge.ics', ICS_MIME, ICS_MAX_BYTES + 1, bytes);

        const res = await authedRequest(token, previewUrl(hugeId));
        expect(res.status).toBe(413);
    });

    test('a file that is not a calendar is refused outright', async () => {
        const file = new File(['ford prefect'], 'notes.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(400);
    });

    test('a file the parser refuses answers 422, never a crash', async () => {
        const uploaded = await uploadIcs('garbage.ics', 'this is not iCalendar at all');

        const res = await authedRequest(token, previewUrl(uploaded.id));
        expect(res.status).toBe(422);
    });

    test('a file the caller cannot read is not previewed', async () => {
        const uploaded = await uploadIcs('private.ics', CALENDAR);
        const ctx = await getTestContext();

        const res = await authedRequest(ctx.bob.user.sessionToken, previewUrl(uploaded.id));
        expect(res.status).toBe(403);
    });
});

// The URL carries only updatedAt, so a payload or sanitizer fix reaches a browser that holds a body
// through the renderer's format tag in the ETag, never through a max-age.
describe('Drive preview routes revalidate against their format tag', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    const cases = [
        { route: 'text-preview', format: TEXT_FORMAT, name: 'etag.txt', mime: 'text/plain', body: 'hello' },
        {
            route: 'vcard-preview',
            format: VCARD_FORMAT,
            name: 'etag.vcf',
            mime: 'text/vcard',
            body: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nEND:VCARD\r\n',
        },
        {
            route: 'eml-preview',
            format: EML_FORMAT,
            name: 'etag.eml',
            mime: EML_MIME,
            body: 'From: ada@external.com\r\nSubject: Notes\r\n\r\nHello\r\n',
        },
        {
            route: 'ics-preview',
            format: ICS_FORMAT,
            name: 'etag.ics',
            mime: ICS_MIME,
            body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@eigen\r\nDTSTART;VALUE=DATE:20260920\r\nSUMMARY:Fair\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        },
    ];

    for (const { route, format, name, mime, body } of cases) {
        test(`${route} answers 304 on its own ETag, and a body on the file's`, async () => {
            const uploaded = await driveUpload(token, ownerId, mountId, rootId, new File([body], name, { type: mime }));
            const url = `/drive/${ownerId}/${mountId}/file/${uploaded.id}/${route}`;

            const first = await authedRequest(token, url);
            expect(first.status).toBe(200);
            expect(first.headers.get('cache-control')).toBe('private, no-cache');
            const etag = first.headers.get('etag') ?? '';
            expect(etag).toEndWith(`-${format}"`);

            const revalidated = await authedRequest(token, url, { headers: { 'if-none-match': etag } });
            expect(revalidated.status).toBe(304);
            expect(revalidated.headers.get('etag')).toBe(etag);

            // The file's own ETag stands for a preview under another format tag: a bump answers the new body.
            const download = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/download`);
            const fileEtag = download.headers.get('etag') ?? '';
            expect(fileEtag).not.toBe('');
            const bumped = await authedRequest(token, url, { headers: { 'if-none-match': fileEtag } });
            expect(bumped.status).toBe(200);
        });
    }

    test('a failed generation carries no validator, so the next request generates again', async () => {
        const file = new File(['hello'], 'flaky.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);
        const url = `/drive/${ownerId}/${mountId}/file/${uploaded.id}/text-preview`;
        const { mount } = await (await getHome(ownerId)).drive.resolveFile(mountId, uploaded.id);
        const readFile = spyOn(mount, 'readFile').mockResolvedValueOnce(null);

        const failed = await authedRequest(token, url);
        readFile.mockRestore();
        expect(failed.status).toBe(404);
        expect(failed.headers.get('etag')).toBeNull();
        expect(failed.headers.get('cache-control')).toBeNull();

        // A browser revalidates with whatever validator it stored, so no validator means a plain request.
        const retried = await authedRequest(token, url);
        expect(retried.status).toBe(200);
        expect((await retried.json()).body).toContain('hello');
    });
});

// A drawing previews as a compositor HTML body, not as an image: it rides the text-preview
// cache like every other eigen container, and the screen-preview route no longer answers for it.
describe('Vector previews are text previews', () => {
    const mountId = 'default';
    let token: string;
    let ownerId: string;
    let vectorPathId: string;
    let emptyVectorPathId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');

        const created = await drivePost(token, ownerId, mountId, `folder/${root.id}/create/vector`, {
            fileName: 'Preview Drawing',
        });
        const home = await getHome(ownerId);
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        seedVectorDoc(collab.doc, buildGoldenVectorScene());
        const resolved = await home.drive.resolveFile(mountId, created.id);
        await seedDocumentMedia(resolved.mount, resolved.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
        vectorPathId = created.id;

        const empty = await drivePost(token, ownerId, mountId, `folder/${root.id}/create/vector`, {
            fileName: 'Empty Preview Drawing',
        });
        emptyVectorPathId = empty.id;
    });

    test('the text-preview route serves a compositor body under the eigenvector mode', async () => {
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${vectorPathId}/text-preview`);
        expect(res.status).toBe(200);
        const value = await res.json();
        expect(value.mode).toBe('eigenvector');
        expect(value.body).toContain('<div class="canvas-page"');
    }, 120_000);

    test('the screen-preview route no longer serves a drawing as an image', async () => {
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${vectorPathId}/preview`);
        expect(res.status).toBe(404);
    }, 120_000);

    test('an empty drawing previews as an empty page, not as a 404', async () => {
        // getOrCacheText caches only a non-empty body, so a bodyless empty drawing would keep
        // serving the preview it had before it was emptied.
        const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${emptyVectorPathId}/text-preview`);
        expect(res.status).toBe(200);
        const value = await res.json();
        expect(value.mode).toBe('eigenvector');
        expect(value.body).toContain('<div class="canvas-page"');
        expect(value.body).not.toContain('<svg');
    }, 120_000);
});
