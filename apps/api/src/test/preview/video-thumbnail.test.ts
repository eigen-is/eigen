import { beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractVideoFrame, isFfmpegAvailable } from '../../lib/shared/video-thumbnail';

const FIXTURES = path.join(import.meta.dir, '../fixtures');
const TINY = path.join(FIXTURES, 'tiny-video.mp4');
const VERY_SHORT = path.join(FIXTURES, 'very-short-video.mp4');
const TMP_DIR = `/tmp/eigen-video-thumb-test-${Date.now()}`;

describe('video-thumbnail', () => {
    let ffmpegAvailable = false;

    beforeAll(async () => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        ffmpegAvailable = await isFfmpegAvailable();
        if (!ffmpegAvailable) {
            console.warn('[video-thumbnail.test] ffmpeg not installed — skipping tests');
        }
    });

    test('isFfmpegAvailable detects the binary', async () => {
        const ok = await isFfmpegAvailable();
        expect(typeof ok).toBe('boolean');
    });

    test('extractVideoFrame returns dims + duration + JPEG buffer from 2s fixture', async () => {
        if (!ffmpegAvailable) return;
        const result = await extractVideoFrame(TINY, TMP_DIR, 'tiny-pathid');
        expect(result).not.toBeNull();
        expect(result!.width).toBe(160);
        expect(result!.height).toBe(120);
        expect(result!.duration).toBeGreaterThan(1.9);
        expect(result!.duration).toBeLessThan(2.5);
        expect(result!.data[0]).toBe(0xff);
        expect(result!.data[1]).toBe(0xd8);
    });

    test('extractVideoFrame falls back to -ss 0 for sub-second video', async () => {
        if (!ffmpegAvailable) return;
        const result = await extractVideoFrame(VERY_SHORT, TMP_DIR, 'short-pathid');
        expect(result).not.toBeNull();
        expect(result!.width).toBe(160);
        expect(result!.height).toBe(120);
        expect(result!.duration).toBeGreaterThan(0.3);
        expect(result!.duration).toBeLessThan(1.0);
    });

    test('extractVideoFrame returns null for non-video input', async () => {
        if (!ffmpegAvailable) return;
        const garbage = path.join(TMP_DIR, 'garbage.bin');
        fs.writeFileSync(garbage, Buffer.from('not a video at all'));
        const result = await extractVideoFrame(garbage, TMP_DIR, 'garbage-pathid');
        expect(result).toBeNull();
    });

    test('extractVideoFrame returns null for missing file', async () => {
        if (!ffmpegAvailable) return;
        const result = await extractVideoFrame('/does/not/exist.mp4', TMP_DIR, 'missing-pathid');
        expect(result).toBeNull();
    });
});
