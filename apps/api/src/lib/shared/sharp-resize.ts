// The thumbnail Worker's resize: one image in, resized and encoded to the format asked for, as a still or with every
// frame, plus the source's size and whether it shows through or holds frames. It is a module of its own, so the
// transform Worker can re-encode a docx's data: figure through it without the thumbnail Worker's message handler.

import type { Sharp } from 'sharp';
import sharp from 'sharp';
import { THUMBNAIL_TIMEOUT_SECONDS } from './thumbnail-timeout';
import type { ImageResult, WorkerInput } from './thumbnail-worker';

export async function sharpResize(
    source: Buffer | string,
    options: WorkerInput['options'],
): Promise<ImageResult | null> {
    try {
        // Only webp and gif hold animation, so only they read every frame of an animated source. Any other target, or
        // a still, reads the first frame only: all frames would stack into one tall filmstrip.
        const animated = !options.still && (options.format === 'webp' || options.format === 'gif');
        const image = sharp(source, { animated });
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) return null;

        const rotated = metadata.orientation && metadata.orientation >= 5;
        const width = rotated ? metadata.pageHeight || metadata.height : metadata.width;
        const height = rotated ? metadata.width : metadata.pageHeight || metadata.height;

        if (width > 32000 || height > 32000) return null;

        const resized = image.rotate().resize(options.maxSize, options.maxSize, {
            fit: options.fit,
            position: 'center',
            withoutEnlargement: options.fit === 'inside',
        });
        // A PNG or a GIF takes no quality setting and encodes at sharp's defaults. WebP is the default target.
        let encoded: Sharp;
        let hasAlpha = metadata.hasAlpha ?? false;
        switch (options.format) {
            case 'jpeg': {
                // A JPEG drops alpha, so its hasAlpha says whether a pixel of the picture shows through: a macOS
                // screenshot carries an alpha channel that is opaque throughout.
                const picture = hasAlpha ? await decodePicture(resized) : null;
                hasAlpha = picture?.showsThrough ?? false;
                encoded = (picture?.pixels ?? resized).jpeg({ quality: options.quality });
                break;
            }
            case 'png':
                encoded = resized.png();
                break;
            case 'gif':
                encoded = resized.gif();
                break;
            default:
                encoded = resized.webp({ quality: options.quality });
        }
        const data = await encoded.timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS }).toBuffer();

        // hasAlpha and frameCount describe the source, even for a still. So an avatar picks its embed format from one
        // decode: a JPEG for an opaque picture, a PNG for one that shows through and a GIF for an animated one.
        return { data, width, height, hasAlpha, frameCount: metadata.pages ?? 1 };
    } catch {
        return null;
    }
}

// The resized picture as raw pixels, which the JPEG is encoded from, and whether one of them shows through. So the
// source is decoded once: sharp's stats of the source would decode it again at full size, seconds for a huge one.
// Sharp hands the pixels back in 8 bits, rounding a 16-bit source's alpha, so a buffer of more than a byte a sample
// counts as see-through and keeps the PNG.
async function decodePicture(resized: Sharp): Promise<{ pixels: Sharp; showsThrough: boolean }> {
    const { data, info } = await resized
        .raw()
        .timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS })
        .toBuffer({ resolveWithObject: true });
    let showsThrough = data.length !== info.width * info.height * info.channels;
    for (let alpha = info.channels - 1; alpha < data.length && !showsThrough; alpha += info.channels) {
        showsThrough = data[alpha] !== 255;
    }
    const raw = { width: info.width, height: info.height, channels: info.channels };
    return { pixels: sharp(data, { raw }), showsThrough };
}
