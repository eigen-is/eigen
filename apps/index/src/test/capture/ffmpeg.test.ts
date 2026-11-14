// Tests the ffmpeg side of the capture tool's recorder: the concat list that times each screencast frame, the cut that
// lines pages up on one start, and the encoder arguments, side by side included.

import { describe, expect, test } from 'bun:test';
import { concatList, encodeArgs, startingAt } from '../../../capture/lib/ffmpeg';

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

describe('startingAt', () => {
    const frames = [
        { file: '/f/0.jpg', time: 10 },
        { file: '/f/1.jpg', time: 10.5 },
        { file: '/f/2.jpg', time: 11 },
    ];

    test('the frame showing at start moves up to it, and the earlier ones go', () => {
        expect(startingAt(frames, 10.7)).toEqual([
            { file: '/f/1.jpg', time: 10.7 },
            { file: '/f/2.jpg', time: 11 },
        ]);
    });

    test('a start on the first frame keeps every frame', () => {
        expect(startingAt(frames, 10)).toEqual(frames);
    });
});

describe('encodeArgs', () => {
    const layout = { height: 1600, gap: 24, color: '#ffffff' };

    test('av1 uses SVT-AV1 at 30 fps and ends with the output', () => {
        const args = encodeArgs('av1', ['/f/list.txt'], layout, '/out/x.av1.mp4');
        expect(args).toContain('libsvtav1');
        expect(args.join(' ')).toContain('fps=30');
        expect(args.at(-1)).toBe('/out/x.av1.mp4');
    });

    test('h264 starts fast on the web at 30 fps and ends with the output', () => {
        const args = encodeArgs('h264', ['/f/list.txt'], layout, '/out/x.h264.mp4');
        expect(args).toContain('libx264');
        expect(args).toContain('+faststart');
        expect(args.join(' ')).toContain('fps=30');
        expect(args.at(-1)).toBe('/out/x.h264.mp4');
    });

    test('the poster is the first frame only', () => {
        const args = encodeArgs('poster', ['/f/list.txt'], layout, '/out/x.png');
        expect(args.slice(-3)).toEqual(['-frames:v', '1', '/out/x.png']);
    });

    test('one page is scaled to the height and stacks nothing', () => {
        const args = encodeArgs('h264', ['/f/list.txt'], layout, '/out/x.h264.mp4');
        expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:v]fps=30,scale=-2:1600[p0];[p0]format=yuv420p[out]');
    });

    test('two pages stand side by side, the first padded with the gap in the background color', () => {
        const args = encodeArgs('av1', ['/f/0.txt', '/f/1.txt'], layout, '/out/x.av1.mp4');
        expect(args.filter((arg) => arg === '-i')).toHaveLength(2);
        expect(args[args.indexOf('-filter_complex') + 1]).toBe(
            '[0:v]fps=30,scale=-2:1600,pad=iw+24:ih:0:0:color=#ffffff[p0];[1:v]fps=30,scale=-2:1600[p1];' +
                '[p0][p1]hstack=inputs=2,format=yuv420p[out]',
        );
        expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2)).toEqual(['-map', '[out]']);
    });
});
