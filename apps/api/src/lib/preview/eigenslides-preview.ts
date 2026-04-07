import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { buildEmbedUrl } from '../export/media';
import { loadSlidesContent } from '../export/slides/content';
import { renderDeckHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';

export async function generateEigenslidesPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const content = await loadSlidesContent(mount, drivePath);
    if (!content) return '';

    const { deck, mediaByName } = content;

    const resolveImgSrc = (mediaName: string): string | null => {
        const file = mediaByName.get(mediaName);
        return file ? buildEmbedUrl(drivePath, file) : null;
    };

    const slidesHtml = renderDeckHtml(deck, responsiveSizeUnit, resolveImgSrc);
    return DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
}
