import { useHotkey } from '@tanstack/react-hotkeys';
import { getDriveItemUrl, getDrivePreviewUrl } from '@workspace/lib/api';
import { useTextPreview } from '@workspace/lib/drive';
import { fileActionsFor } from '@workspace/lib/file-actions';
import { getPreviewMode, subjectInfo } from '@workspace/lib/file-subject';
import { useMailTextPreview } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject, MailPartRef } from '@workspace/lib/types/file-subject';
import type { TextPreviewResult } from '@workspace/lib/types/preview';
import { useFocusTrap } from '@workspace/ui/hooks/use-focus-trap';
import { CHECKERBOARD_STYLE, cn } from '@workspace/ui/lib/utils';
import { ChevronLeft, ChevronRight, ExternalLink, FolderDown, Loader2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { getFileIcon } from './file-presentation';
import { MailVCardPreviewContent, PREVIEW_PANE_CLASS, VCardPreviewContent } from './vcard-preview-content';

type FilePreviewProps = {
    subject: FileSubject;
    siblings: FileSubject[];
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
};

export function FilePreview({ subject, siblings, onClose, onPrev, onNext }: FilePreviewProps) {
    const runner = useFileActionRunner(subject, siblings);
    const { drive } = subject;
    const info = subjectInfo(subject);
    const previewMode = getPreviewMode(subject);
    // The transcode route is a Drive item's alone; anything else previews the bytes it embeds.
    const previewUrl = drive
        ? getDrivePreviewUrl(drive.ownerId, drive.mountId, drive.id, new Date(drive.updatedAt))
        : info.embedUrl;
    const aspectRatio =
        drive?.details?.width && drive.details.height ? drive.details.width / drive.details.height : undefined;
    const index = siblings.findIndex((sibling) => subjectInfo(sibling).key === info.key);
    const hasPrev = index > 0;
    const hasNext = index >= 0 && index < siblings.length - 1;

    // Both listen on document and Radix stops nothing: ungated, one Escape would close the dialog and the overlay.
    const keysEnabled = !runner.isDialogOpen;
    useHotkey('Escape', () => onClose(), { enabled: keysEnabled });
    // Space closes it again, the way it opened it (Finder's Quick Look).
    useHotkey('Space', () => onClose(), { enabled: keysEnabled, preventDefault: true });
    const goPrev = () => {
        if (hasPrev) onPrev();
    };
    const goNext = () => {
        if (hasNext) onNext();
    };
    useHotkey('ArrowLeft', goPrev, { enabled: keysEnabled });
    useHotkey('ArrowUp', goPrev, { enabled: keysEnabled });
    useHotkey('ArrowRight', goNext, { enabled: keysEnabled });
    useHotkey('ArrowDown', goNext, { enabled: keysEnabled });

    // Focus stays in the overlay except while a dialog, portaled to body, holds it.
    const overlayRef = useRef<HTMLDivElement>(null);
    useFocusTrap(overlayRef, !runner.isDialogOpen);

    const openUrl = drive ? getDriveItemUrl(drive) : undefined;
    const downloadableSiblings = siblings.filter((sibling) => !!subjectInfo(sibling).downloadUrl);

    return (
        <div
            ref={overlayRef}
            data-preview-overlay
            role="dialog"
            aria-modal="true"
            aria-label={info.name}
            tabIndex={-1}
            className="fixed inset-0 z-[100] bg-black/80 flex flex-col animate-in fade-in outline-none"
            style={{ pointerEvents: 'auto' }}
            // Synthetic events bubble across portals, so a click inside the picker would land here too.
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-4 py-2 bg-black/40 text-white shrink-0"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium">{info.name}</span>
                </div>
                <div className="flex items-center gap-1">
                    <NavButton onClick={onPrev} disabled={!hasPrev} title="Previous (←)">
                        <ChevronLeft className="size-4" />
                    </NavButton>
                    <NavButton onClick={onNext} disabled={!hasNext} title="Next (→)">
                        <ChevronRight className="size-4" />
                    </NavButton>
                    <NavButton onClick={onClose} title="Close (Esc)">
                        <X className="size-4" />
                    </NavButton>
                </div>
            </div>

            {/* Content */}
            <div
                className="flex-1 flex items-center justify-center overflow-hidden min-h-0"
                onClick={onClose}
                style={{ cursor: 'zoom-out' }}
            >
                <div
                    className="max-w-[90vw] max-h-[calc(100vh-7rem)] flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                    style={{ cursor: 'default' }}
                >
                    {previewMode === 'image' && (
                        // Keyed so a sibling never inherits the previous image's loaded flag or measured ratio.
                        <ProgressiveImage
                            key={previewUrl}
                            thumbnailUrl={info.thumbnailUrl}
                            previewUrl={previewUrl}
                            alt={info.name}
                            aspectRatio={aspectRatio}
                        />
                    )}
                    {previewMode === 'video' && (
                        <video
                            src={info.embedUrl}
                            controls
                            autoPlay
                            className="max-w-full max-h-[calc(100vh-7rem)] rounded"
                            style={aspectRatio ? { aspectRatio: `${aspectRatio}` } : undefined}
                        />
                    )}
                    {previewMode === 'audio' && (
                        <div className="bg-background rounded-lg p-8 flex flex-col items-center gap-4">
                            <span className="text-sm text-muted-foreground">{info.name}</span>
                            <audio src={info.embedUrl} controls autoPlay className="w-80" />
                        </div>
                    )}
                    {previewMode === 'pdf' && (
                        <iframe src={info.embedUrl} className={cn(PREVIEW_PANE_CLASS, 'rounded bg-background')} />
                    )}
                    {/* One shape from Drive and mail; the identity picks the query, one hook per component. */}
                    {previewMode === 'text' && drive && <TextPreviewContent path={drive} />}
                    {previewMode === 'text' && subject.mail && <MailTextPreviewContent part={subject.mail} />}
                    {previewMode === 'vcard' && drive && <VCardPreviewContent path={drive} />}
                    {previewMode === 'vcard' && subject.mail && (
                        <MailVCardPreviewContent part={subject.mail} size={info.size} />
                    )}
                    {previewMode === 'fallback' && (
                        <div className="flex flex-col items-center gap-4 text-white">
                            {getFileIcon(info.mimeType, drive?.type ?? 'file', info.name, {
                                className: 'size-16 text-muted-foreground',
                            })}
                            <span className="text-lg font-medium">{info.name}</span>
                            <span className="text-sm text-muted-foreground">No preview available</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Footer */}
            <div
                className="flex items-center justify-center gap-2 px-4 py-2 bg-black/40 shrink-0"
                onClick={(e) => e.stopPropagation()}
            >
                {openUrl && (
                    <FooterButton href={openUrl}>
                        <ExternalLink className="size-3.5" />
                        Open
                    </FooterButton>
                )}
                {/* The overlay is Quick Look itself, so the registry's own row is the one it drops. */}
                {fileActionsFor(subject, ['quick-look']).map((action) => (
                    <FooterActionButton key={action.id} onClick={() => runner.run(action)} disabled={runner.isPending}>
                        <action.icon className="size-3.5" />
                        {action.label}
                    </FooterActionButton>
                ))}
                {subject.attachment && downloadableSiblings.length >= 2 && (
                    <FooterActionButton
                        onClick={() => runner.openPicker(downloadableSiblings)}
                        disabled={runner.isPending}
                    >
                        <FolderDown className="size-3.5" />
                        Save all ({downloadableSiblings.length})
                    </FooterActionButton>
                )}
            </div>
            {runner.dialogs}
        </div>
    );
}

function TextPreviewContent({ path }: { path: DrivePath }) {
    const { data, isLoading } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, true);
    return <TextPreviewBody data={data} isLoading={isLoading} />;
}

function MailTextPreviewContent({ part }: { part: MailPartRef }) {
    const { data, isLoading } = useMailTextPreview(part.ownerId, part.messageId, part.index, true);
    return <TextPreviewBody data={data} isLoading={isLoading} />;
}

function TextPreviewBody({ data, isLoading }: { data: TextPreviewResult | undefined; isLoading: boolean }) {
    if (isLoading) {
        return (
            <div className={cn('flex items-center justify-center', PREVIEW_PANE_CLASS)}>
                <Loader2 className="size-6 text-white animate-spin" />
            </div>
        );
    }

    if (!data?.body) {
        return (
            <div className={cn('flex items-center justify-center', PREVIEW_PANE_CLASS, 'text-white text-sm')}>
                No preview available
            </div>
        );
    }

    return (
        <div className={cn(PREVIEW_PANE_CLASS, 'overflow-auto rounded bg-background')}>
            {data.mode === 'eigendoc' ? (
                <div className="p-[2cm] w-[210mm] mx-auto">
                    <div className="eigen-prose tiptap" dangerouslySetInnerHTML={{ __html: data.body }} />
                </div>
            ) : data.mode === 'eigenslides' ? (
                <div className="p-8 bg-muted/50 min-h-full">
                    <div
                        className="w-full max-w-[960px] mx-auto flex flex-col gap-4 [&>.page-fit]:rounded [&>.page-fit]:shadow-md"
                        dangerouslySetInnerHTML={{ __html: data.body }}
                    />
                </div>
            ) : data.mode === 'eigensheets' ? (
                <div className="p-8 min-h-full">
                    <div className="eigensheets-preview mx-auto" dangerouslySetInnerHTML={{ __html: data.body }} />
                </div>
            ) : data.mode === 'eigenvector' ? (
                <div className="p-8 min-h-full flex justify-center">
                    <div className="w-full max-w-[960px]" dangerouslySetInnerHTML={{ __html: data.body }} />
                </div>
            ) : (
                <div
                    className="eigen-prose p-8 max-w-4xl mx-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
                    dangerouslySetInnerHTML={{ __html: data.body }}
                />
            )}
        </div>
    );
}

function NavButton({
    onClick,
    disabled,
    title,
    children,
}: {
    onClick: () => void;
    disabled?: boolean;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="p-1.5 rounded hover:bg-white/20 disabled:opacity-30 disabled:cursor-default transition-colors"
        >
            {children}
        </button>
    );
}

function ProgressiveImage({
    thumbnailUrl,
    previewUrl,
    alt,
    aspectRatio,
}: {
    thumbnailUrl?: string;
    previewUrl: string;
    alt: string;
    aspectRatio?: number;
}) {
    const [previewReady, setPreviewReady] = useState(false);
    // Without known dimensions the box hugs the image once loaded, so clicks beside it still reach the backdrop.
    const [loadedRatio, setLoadedRatio] = useState<number>();

    const ratio = aspectRatio ?? loadedRatio;
    // Once the ratio is known the box is exactly the image area, so the checkerboard sits only
    // behind the image: transparent line art stays readable on the dark backdrop.
    const style: React.CSSProperties = ratio
        ? {
              width: `min(90vw, calc((100vh - 7rem) * ${ratio}))`,
              height: `min(calc(100vh - 7rem), calc(90vw / ${ratio}))`,
              ...CHECKERBOARD_STYLE,
          }
        : { width: '90vw', height: 'calc(100vh - 7rem)' };

    return (
        <div className="relative rounded" style={style}>
            {/* Thumbnail: always visible until preview is ready */}
            {thumbnailUrl && (
                <img src={thumbnailUrl} alt={alt} className="absolute inset-0 w-full h-full rounded object-contain" />
            )}
            {/* Full preview: loads in background, fades in on top when ready */}
            <img
                src={previewUrl}
                alt={alt}
                className="absolute inset-0 w-full h-full rounded object-contain transition-opacity duration-300"
                style={{ opacity: previewReady ? 1 : 0 }}
                onLoad={(e) => {
                    setPreviewReady(true);
                    setLoadedRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
                }}
            />
        </div>
    );
}

function FooterButton({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm transition-colors"
        >
            {children}
        </a>
    );
}

function FooterActionButton({
    onClick,
    disabled,
    children,
}: {
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-default text-white text-sm transition-colors"
        >
            {children}
        </button>
    );
}
