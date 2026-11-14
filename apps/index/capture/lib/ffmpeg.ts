// The ffmpeg side of the capture recorder: the concat list that times a page's screencast frames, and the arguments
// that turn it into an AV1 or H.264 mp4 at a steady 30 fps. It imports nothing from the browser, so its tests run
// without the capture tool's own install.

export type Frame = { file: string; time: number };
export type Codec = 'av1' | 'h264';

// A screen recording barely changes from frame to frame, so one keyframe per loop (600 frames, 20 s) halves the
// files. At these settings AV1 comes out at about two thirds of H.264's size and still looks sharper.
const KEYFRAME_INTERVAL = '600';
const CODEC_ARGS: Record<Codec, string[]> = {
    av1: ['-c:v', 'libsvtav1', '-crf', '40', '-preset', '4', '-g', KEYFRAME_INTERVAL],
    h264: ['-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-g', KEYFRAME_INTERVAL, '-movflags', '+faststart'],
};

// The concat demuxer gives each file the duration under it, and needs the last file again to honor the last one.
export function concatList(frames: readonly Frame[], stopTime: number): string {
    const lines = ['ffconcat version 1.0'];
    for (const [i, frame] of frames.entries()) {
        const until = frames[i + 1]?.time ?? stopTime;
        lines.push(`file '${frame.file}'`, `duration ${(until - frame.time).toFixed(3)}`);
    }
    lines.push(`file '${frames[frames.length - 1].file}'`, '');
    return lines.join('\n');
}

export function encodeArgs(codec: Codec, listPath: string, outPath: string): string[] {
    return [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-vf',
        'fps=30,format=yuv420p',
        ...CODEC_ARGS[codec],
        outPath,
    ];
}
