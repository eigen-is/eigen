import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

// A PDF's pixels, for the tests that read what WeasyPrint printed. CI installs no rasterizer, so those suites skip
// without one.

// The PDF's first page at 72 dpi, one pixel per point: macOS's sips or poppler's pdftoppm.
export const rasterizer = Bun.which('sips') ?? Bun.which('pdftoppm');

export type Raster = { data: Buffer; width: number; height: number };

export async function rasterize(pdf: Buffer): Promise<Raster> {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-raster-'));
    try {
        await Bun.write(join(dir, 'page.pdf'), pdf);
        const args = rasterizer?.endsWith('sips')
            ? ['-s', 'format', 'png', 'page.pdf', '--out', 'page.png']
            : ['-png', '-r', '72', '-singlefile', 'page.pdf', 'page'];
        const proc = Bun.spawn([rasterizer ?? '', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
        expect(await proc.exited).toBe(0);
        const { data, info } = await sharp(join(dir, 'page.png'))
            .flatten({ background: '#ffffff' })
            .raw()
            .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export type Rgb = [number, number, number];

// The pixel at a point of the page, in points.
export function pixelAt(page: Raster, x: number, y: number): Rgb {
    const i = (Math.round(y) * page.width + Math.round(x)) * 3;
    return [page.data[i], page.data[i + 1], page.data[i + 2]];
}
