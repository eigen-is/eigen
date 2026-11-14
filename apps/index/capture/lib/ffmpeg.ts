// The ffmpeg side of the capture recorder: the concat list that times one page's screencast frames, and the arguments
// that turn one list or more into an AV1 or H.264 mp4 at a steady 30 fps, or a png of the first frame for the poster.
// More than one page stand side by side, with a quiet grey seam between them. It imports nothing from the browser, so
// its tests run without the capture tool's own install.

export type Frame = { file: string; time: number };
export type Output = 'av1' | 'h264' | 'poster';
// Every page is scaled to one height in pixels, and a seam in that color separates two pages.
export type Layout = { height: number; color: string };

const SEAM_WIDTH = 24;

// A screen recording barely changes from frame to frame, so one keyframe per loop (600 frames, 20 s) halves the
// files. At these settings AV1 comes out at about two thirds of H.264's size and still looks sharper.
const KEYFRAME_INTERVAL = '600';
const OUTPUT_ARGS: Record<Output, string[]> = {
    av1: ['-c:v', 'libsvtav1', '-crf', '40', '-preset', '4', '-g', KEYFRAME_INTERVAL],
    h264: ['-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-g', KEYFRAME_INTERVAL, '-movflags', '+faststart'],
    poster: ['-frames:v', '1'],
};

// The frames from start on, the last one before start moved up to it. Chrome times frames by the wall clock, so
// pages filmed side by side and cut to one start line up.
export function startingAt(frames: readonly Frame[], start: number): Frame[] {
    const showing = frames.findLastIndex((frame) => frame.time <= start);
    const first = Math.max(0, showing);
    return [{ ...frames[first], time: start }, ...frames.slice(first + 1)];
}

// The concat demuxer gives each file the duration under it, and needs the last file again to honor the last one.
export function concatList(frames: readonly Frame[], stopTime: number): string {
    const shown = frames.filter((frame) => frame.time < stopTime);
    const lines = ['ffconcat version 1.0'];
    for (const [i, frame] of shown.entries()) {
        const until = shown[i + 1]?.time ?? stopTime;
        lines.push(`file '${frame.file}'`, `duration ${(until - frame.time).toFixed(3)}`);
    }
    lines.push(`file '${shown[shown.length - 1].file}'`, '');
    return lines.join('\n');
}

export function encodeArgs(output: Output, listPaths: readonly string[], layout: Layout, outPath: string): string[] {
    const last = listPaths.length - 1;
    const seam = `,pad=iw+${SEAM_WIDTH}:ih:0:0:color=${layout.color}`;
    const pages = listPaths.map((_, i) => `[${i}:v]fps=30,scale=-2:${layout.height}${i < last ? seam : ''}[p${i}]`);
    const inputs = listPaths.map((_, i) => `[p${i}]`).join('');
    const stack = last > 0 ? `hstack=inputs=${listPaths.length},` : '';
    return [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        ...listPaths.flatMap((listPath) => ['-f', 'concat', '-safe', '0', '-i', listPath]),
        '-filter_complex',
        `${pages.join(';')};${inputs}${stack}format=yuv420p[out]`,
        '-map',
        '[out]',
        ...OUTPUT_ARGS[output],
        outPath,
    ];
}
