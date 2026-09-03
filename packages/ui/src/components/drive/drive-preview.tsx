import { getDriveItemThumbnail } from '@workspace/lib/api';
import { CANVAS_PREVIEW_WIDTH, getTextPreviewMode, type TextPreviewMode } from '@workspace/lib/constants';
import { A4_WIDTH_PX } from '@workspace/lib/docs/eigendoc';
import { useTextPreview } from '@workspace/lib/drive';
import { SLIDE_BASE_WIDTH } from '@workspace/lib/slides';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { getFilePresentation } from './file-presentation';

type DrivePreviewProps = {
    path: DrivePath;
    onActivate?: () => void;
    className?: string;
};

// Fixed 16:9 aspect keeps the panel height stable as the user clicks through files.
export function DrivePreview({ path, onActivate, className }: DrivePreviewProps) {
    const presentation = getFilePresentation(path.mimeType, path.type);
    const hasTextPreview = getTextPreviewMode(path.mimeType, path.name) !== null;
    const { showThumbnail, thumbnailUrl } = getDriveItemThumbnail(path);

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
                className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded-full bg-background text-[10px] font-medium uppercase tracking-wider"
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

// The width a mode composes at, so the hero scales by containerW / that width: text modes render
// into an A4 page, slides have a 16:9 base width, a drawing composes at CANVAS_PREVIEW_WIDTH. Sheets
// vary with their content — null falls back to measuring the rendered body.
const INTRINSIC_WIDTH: Record<TextPreviewMode, number | null> = {
    eigendoc: A4_WIDTH_PX,
    eigenslides: SLIDE_BASE_WIDTH,
    eigensheets: null,
    eigenvector: CANVAS_PREVIEW_WIDTH,
    markdown: A4_WIDTH_PX,
    plaintext: A4_WIDTH_PX,
    code: A4_WIDTH_PX,
};

// eigen-prose for rendered prose, drive-preview-code for raw <pre><code> blocks — eigen-prose's
// <pre> rule paints a dark code-block background that is wrong for a whole-file code thumbnail.
// Slides and drawings need none: those bodies carry their own box and their own paint.
const WRAPPER_CLASS: Record<TextPreviewMode, string> = {
    eigendoc: 'eigen-prose tiptap',
    eigenslides: '',
    eigensheets: 'eigensheets-preview',
    eigenvector: '',
    markdown: 'eigen-prose',
    plaintext: 'eigen-prose',
    code: 'drive-preview-code',
};

// Scale a server-rendered HTML preview down to fit the thumbnail panel.
function HtmlPreview({ path, tintColor }: { path: DrivePath; tintColor: string }) {
    const { data } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, true);
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);

    const intrinsicWidth = data ? INTRINSIC_WIDTH[data.mode] : null;
    // The A4 page's own margin, so a text thumbnail is a proportional miniature of the printed page.
    const intrinsicPadding = intrinsicWidth === A4_WIDTH_PX ? '2cm' : undefined;

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

    return (
        <div ref={containerRef} className="drive-preview-hero absolute inset-0 bg-background pointer-events-none">
            <div
                ref={contentRef}
                className={WRAPPER_CLASS[data.mode]}
                style={{
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    ...(intrinsicWidth ? { width: `${intrinsicWidth}px` } : null),
                    ...(intrinsicPadding ? { padding: intrinsicPadding } : null),
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
