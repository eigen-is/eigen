// Tests the ffmpeg side of the capture tool's recorder: the concat list that times each screencast frame, and the
// encoder arguments.

import { describe, expect, test } from 'bun:test';
import { concatList, encodeArgs } from '../../../capture/lib/ffmpeg';

describe('concatList', () => {
    test('each frame lasts until the next, the last until stop, and the last file is repeated', () => {
        const frames = [
            { file: '/f/0.jpg', time: 0 },
            { file: '/f/1.jpg', time: 0.1 },
            { file: '/f/2.jpg', time: 0.25 },
        ];
        expect(concatList(frames, 1).split('\n')).toEqual([
            'ffconcat version 1.0',
            "file '/f/0.jpg'",
            'duration 0.100',
            "file '/f/1.jpg'",
            'duration 0.150',
            "file '/f/2.jpg'",
            'duration 0.750',
            "file '/f/2.jpg'",
            '',
        ]);
    });
});

describe('encodeArgs', () => {
    test('av1 uses SVT-AV1 at 30 fps and ends with the output', () => {
        const args = encodeArgs('av1', '/f/list.txt', '/out/x.av1.mp4');
        expect(args).toContain('libsvtav1');
        expect(args.join(' ')).toContain('fps=30');
        expect(args.at(-1)).toBe('/out/x.av1.mp4');
    });

    test('h264 starts fast on the web at 30 fps and ends with the output', () => {
        const args = encodeArgs('h264', '/f/list.txt', '/out/x.h264.mp4');
        expect(args).toContain('libx264');
        expect(args).toContain('+faststart');
        expect(args.join(' ')).toContain('fps=30');
        expect(args.at(-1)).toBe('/out/x.h264.mp4');
    });
});
