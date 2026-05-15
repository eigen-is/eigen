import { getDriveThumbnailUrl } from '@workspace/lib/api';
import { getTextPreviewMode } from '@workspace/lib/constants';
import { A4_WIDTH_PX } from '@workspace/lib/docs/eigendoc';
import { useTextPreview } from '@workspace/lib/drive';
import { SLIDE_BASE_WIDTH } from '@workspace/lib/slides';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import { getFilePresentation } from './file-presentation';

type DrivePreviewProps = {
    path: DrivePath;
    onActivate?: () => void;
    className?: string;
};

// Fixed 16:9 aspect keeps the panel height stable as the user clicks through files.
export function DrivePreview({ path, onActivate, className }: DrivePreviewProps) {
    const presentation = getFilePresentation(path.mimeType, path.type);
    const isImage = path.mimeType.startsWith('image/');
    const isVideo = path.mimeType.startsWith('video/');
    const hasTextPreview = getTextPreviewMode(path.mimeType, path.name) !== null;
    const showThumbnail = (isImage || isVideo) && !!path.thumbnail;

    const v = path.updatedAt instanceof Date ? path.updatedAt.getTime() : new Date(path.updatedAt).getTime();
    const thumbnailUrl = path.thumbnail
        ? `${getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail)}?v=${v}`
        : undefined;

    const interactive = !!onActivate;
    const Wrapper = interactive ? 'button' : 'div';

    return (
        <Wrapper
            type={interactive ? 'button' : undefined}
            onClick={onActivate}
            className={cn(
                'relative w-full aspect-[16/9] overflow-hidden rounded-lg block text-left',
                interactive && 'cursor-pointer hover:ring-2 hover:ring-ring transition-shadow',
                className,
            )}
            style={{ backgroundColor: presentation.softColorVar }}
        >
            <span
                className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full bg-background text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: presentation.colorVar }}
            >
                {presentation.label}
            </span>

            {showThumbnail && thumbnailUrl ? (
                <>
                    <img
                        src={thumbnailUrl}
                        alt=""
                        aria-hidden
                        className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-70"
                    />
                    <img src={thumbnailUrl} alt={path.name} className="absolute inset-0 w-full h-full object-contain" />
                </>
            ) : hasTextPreview ? (
                <HtmlPreview path={path} tintColor={presentation.colorVar} />
            ) : (
                <IconFallback icon={presentation.icon} color={presentation.colorVar} />
            )}
        </Wrapper>
    );
}

function IconFallback({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center">
            <Icon className="size-16" style={{ color }} strokeWidth={1.5} />
        </div>
    );
}

// Scale a server-rendered HTML preview down to fit the thumbnail panel.
// Eigendoc and eigenslides have a known intrinsic width (A4, 16:9 base) — we
// render at that width and scale by containerW / intrinsicWidth. Other modes
// (sheets, code, text) reflow to the container so we measure scrollWidth.
function HtmlPreview({ path, tintColor }: { path: DrivePath; tintColor: string }) {
    const { data } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, true);
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);

    const intrinsicWidth =
        data?.mode === 'eigendoc' ? A4_WIDTH_PX : data?.mode === 'eigenslides' ? SLIDE_BASE_WIDTH : null;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => {
            const containerW = container.clientWidth;
            if (containerW <= 0) return;
            if (intrinsicWidth) {
                setScale(containerW / intrinsicWidth);
                return;
            }
            const content = contentRef.current;
            if (!content) return;
            const contentW = content.scrollWidth;
            if (contentW > 0) setScale(containerW / contentW);
        };
        const obs = new ResizeObserver(measure);
        obs.observe(container);
        if (!intrinsicWidth && contentRef.current) obs.observe(contentRef.current);
        measure();
        return () => obs.disconnect();
    }, [data?.body, intrinsicWidth]);

    if (!data?.body) return null;

    const mode = data.mode;
    const wrapperClass =
        mode === 'eigendoc'
            ? 'eigen-prose tiptap'
            : mode === 'eigenslides'
              ? 'drive-preview-slides'
              : mode === 'eigensheets'
                ? 'eigensheets-preview'
                : mode === 'code'
                  ? 'drive-preview-code'
                  : 'eigen-prose';

    return (
        <div ref={containerRef} className="drive-preview-hero absolute inset-0 bg-background pointer-events-none">
            <div
                ref={contentRef}
                className={wrapperClass}
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    ...(intrinsicWidth ? { width: `${intrinsicWidth}px` } : null),
                }}
                dangerouslySetInnerHTML={{ __html: data.body }}
            />
            <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: `color-mix(in oklab, ${tintColor} 12%, transparent)` }}
            />
        </div>
    );
}
