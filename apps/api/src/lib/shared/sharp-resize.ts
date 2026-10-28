// The thumbnail Worker's resize: one image in, resized and encoded to the format asked for, with the source's size and
// whether it holds alpha or frames. It is its own module so the transform Worker re-encodes a docx's data: figure through
// it without the thumbnail Worker's message handler.

import type { Sharp } from 'sharp';
import sharp from 'sharp';
import { THUMBNAIL_TIMEOUT_SECONDS } from './thumbnail-timeout';
import type { ImageResult, WorkerInput } from './thumbnail-worker';

export async function sharpResize(
    source: Buffer | string,
    options: WorkerInput['options'],
): Promise<ImageResult | null> {
    try {
        // Only webp and gif hold animation — every other target decodes the first frame only, so reading all
        // pages of an animated source (which would stack them into one tall filmstrip) is confined to those two.
        const animated = options.format === 'webp' || options.format === 'gif';
        const image = sharp(source, { animated });
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) return null;

        const rotated = metadata.orientation && metadata.orientation >= 5;
        const width = rotated ? metadata.pageHeight || metadata.height! : metadata.width;
        const height = rotated ? metadata.width : metadata.pageHeight || metadata.height!;

        if (width > 32000 || height > 32000) return null;

        const resized = image.rotate().resize(options.maxSize, options.maxSize, {
            fit: options.fit,
            position: 'center',
            withoutEnlargement: options.fit === 'inside',
        });
        // png/gif take no quality — they encode at sharp's defaults; webp is the default target.
        let encoded: Sharp;
        switch (options.format) {
            case 'jpeg':
                encoded = resized.jpeg({ quality: options.quality });
                break;
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

        // hasAlpha/frameCount describe the pristine source, so the avatar-staging caller can pick the embed
        // format (opaque still → JPEG, alpha → PNG, animated → GIF) from one decode. A JPEG, which drops alpha, asks
        // whether any pixel is see-through, as a macOS screenshot carries an alpha channel opaque throughout. That
        // reads every pixel again, so only a JPEG of a source with the channel pays for it.
        const hasAlpha =
            (metadata.hasAlpha ?? false) && (options.format !== 'jpeg' || !(await sharp(source).stats()).isOpaque);
        return { data, width, height, hasAlpha, frameCount: metadata.pages ?? 1 };
    } catch {
        return null;
    }
}
