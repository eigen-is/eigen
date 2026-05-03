import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { readSlidesContent } from '../document/slides';
import { buildPreviewUrl } from '../export/media';
import { renderDeckHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';

export async function generateEigenslidesPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const { deck, mediaByName } = await readSlidesContent(mount, drivePath);

    const resolveImgSrc = (mediaName: string): string | null => {
        const file = mediaByName.get(mediaName);
        return file ? buildPreviewUrl(drivePath, file) : null;
    };

    const slidesHtml = renderDeckHtml(deck, responsiveSizeUnit, resolveImgSrc);
    return DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
}
