import type { SheetImage } from '@workspace/lib/sheets';
import { ImagePlaceholder } from '@workspace/ui/components/media/image-placeholder';
import { useContext, useMemo } from 'react';
import { WorkbookContext } from '../../context';

// An image's file through the app's media resolver, or a placeholder while it uploads and once it is gone.
// draggable={false}: the browser's own image drag would take the pointer from the frame's move.
export function ImageContent({ image }: { image: SheetImage }) {
    const { settings } = useContext(WorkbookContext);
    const { url, missing } = useMemo(
        () => ({
            url: settings.hooks?.resolveImageUrl?.(image.mediaName) ?? null,
            missing: !!settings.hooks?.isImageMissing?.(image.mediaName),
        }),
        [image.mediaName, settings.hooks],
    );
    if (!url) return <ImagePlaceholder missing={missing} />;
    return <img src={url} alt="" draggable={false} decoding="async" className="block size-full" />;
}
