// What a floating image draws: its file through the document's media resolver, or a placeholder while it uploads and
// once it is gone. The resolver's own context renders it when the media listing changes.

import { useMediaResolver } from '@workspace/lib/drive';
import type { SheetImage } from '@workspace/lib/sheets';
import { ImagePlaceholder } from '@workspace/ui/components/media';
import { useMemo } from 'react';

// draggable={false}: the browser's own image drag would take the pointer from the frame's move.
export function ImageContent({ image }: { image: SheetImage }) {
    const { resolveMediaUrl, isMediaMissing } = useMediaResolver();
    const { url, missing } = useMemo(
        () => ({ url: resolveMediaUrl(image.mediaName), missing: isMediaMissing(image.mediaName) }),
        [image.mediaName, resolveMediaUrl, isMediaMissing],
    );
    if (!url) return <ImagePlaceholder missing={missing} />;
    return <img src={url} alt="" draggable={false} decoding="async" className="block size-full" />;
}
