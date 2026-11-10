// A blog post's cover image, a 16:9 frame cropped from the top of the picture. The overview shows the newest post's
// with its teaser, and the post page shows it under the title.

import { cn } from '@workspace/ui/lib/utils';

export function BlogCover({ src, className }: { src: string; className?: string }) {
    return (
        <div className={cn('aspect-video overflow-hidden rounded-xl border', className)}>
            <img src={src} alt="" className="h-full w-full object-cover object-top" />
        </div>
    );
}
