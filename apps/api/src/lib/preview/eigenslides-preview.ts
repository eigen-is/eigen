import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { loadSlidesContent } from '../export/slides/content';
import { renderSlideHtml, responsiveSizeUnit } from '../export/slides/render';
import type { Mount } from '../mount';

export async function generateEigenslidesPreview(mount: Mount, drivePath: DrivePath, baseUrl = ''): Promise<string> {
    const content = await loadSlidesContent(mount, drivePath);
    if (!content) return '';

    const { deck, mediaByName } = content;

    const resolveImgSrc = (mediaName: string): string | null => {
        const file = mediaByName.get(mediaName);
        if (!file) return null;
        return `${baseUrl}/drive/${drivePath.ownerId}/${drivePath.mountId}/file/${file.pathId}/embed/${encodeURIComponent(file.name)}`;
    };

    const slidesHtml = deck.slideOrder
        .map((slideId) => {
            const slide = deck.slides[slideId];
            if (!slide) return '';
            const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);
            return renderSlideHtml(slide, objects, responsiveSizeUnit, resolveImgSrc);
        })
        .filter(Boolean)
        .join('<div style="height:1rem"></div>');

    return DOMPurify.sanitize(slidesHtml, { FORCE_BODY: true });
}
