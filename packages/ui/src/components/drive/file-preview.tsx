import { useHotkey } from '@tanstack/react-hotkeys';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useTextPreview } from '@workspace/lib/drive';
import { fileActionsFor } from '@workspace/lib/file-actions';
import type { PreviewMode } from '@workspace/lib/file-subject';
import { useMailTextPreview } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject, MailPartRef } from '@workspace/lib/types/file-subject';
import { useFocusTrap } from '@workspace/ui/hooks/use-focus-trap';
import { ChevronLeft, ChevronRight, ExternalLink, FolderDown, Loader2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { getFileIcon } from './file-presentation';
import { MailVCardPreviewContent, VCardPreviewContent } from './vcard-preview-content';

type FilePreviewProps = {
    previewMode: PreviewMode;
    previewUrl: string;
    aspectRatio?: number;
    hasPrev: boolean;
    hasNext: boolean;
    subject: FileSubject;
    siblings: FileSubject[];
    // The siblings are one container's attachments: a set to act on as a whole, not just a list to
    // page through.
    attachment: boolean;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
};

export function FilePreview({
    previewMode,
    previewUrl,
    aspectRatio,
    hasPrev,
    hasNext,
    subject,
    siblings,
    attachment,
    onClose,
    onPrev,
    onNext,
}: FilePreviewProps) {
    useHotkey('Escape', () => onClose(), { enabled: true });
    // Space closes it again, the way it opened it (Finder's Quick Look).
    useHotkey('Space', () => onClose(), { enabled: true, preventDefault: true });
    // The siblings arrive in the list's own order, so up/down step exactly like the drive list
    // does and left/right mean the same thing.
    const goPrev = () => {
        if (hasPrev) onPrev();
    };
    const goNext = () => {
        if (hasNext) onNext();
    };
    useHotkey('ArrowLeft', goPrev, { enabled: true });
    useHotkey('ArrowUp', goPrev, { enabled: true });
    useHotkey('ArrowRight', goNext, { enabled: true });
    useHotkey('ArrowDown', goNext, { enabled: true });

    const runner = useFileActionRunner(subject, siblings, { attachment });

    // Trap focus in the overlay, but hand it to a picker (a Radix dialog portaled to body)
    // while one is open.
    const overlayRef = useRef<HTMLDivElement>(null);
    useFocusTrap(overlayRef, !runner.isDialogOpen);

    const openUrl = subject.drive ? getDriveItemUrl(subject.drive) : undefined;
    const downloadableSiblings = siblings.filter((s) => !!s.downloadUrl);

    return (
        <div
            ref={overlayRef}
            data-preview-overlay
            role="dialog"
            aria-modal="true"
            aria-label={subject.name}
            tabIndex={-1}
            className="fixed inset-0 z-[100] bg-black/80 flex flex-col animate-in fade-in outline-none"
            style={{ pointerEvents: 'auto' }}
            // React synthetic events bubble through the React tree across portals, so a
            // click inside the save-to-drive picker (rendered as a JSX child below) would
            // bubble here and dismiss the preview. Only close on direct overlay clicks.
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
                    <span className="truncate text-sm font-medium">{subject.name}</span>
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
                        // Keyed: paging to a sibling must not inherit the loaded flag or the measured
                        // ratio of the image before it.
                        <ProgressiveImage
                            key={previewUrl}
                            thumbnailUrl={subject.thumbnailUrl}
                            previewUrl={previewUrl}
                            alt={subject.name}
                            aspectRatio={aspectRatio}
                        />
                    )}
                    {previewMode === 'video' && (
                        <video
                            src={subject.embedUrl}
                            controls
                            autoPlay
                            className="max-w-full max-h-[calc(100vh-7rem)] rounded"
                            style={aspectRatio ? { aspectRatio: `${aspectRatio}` } : undefined}
                        />
                    )}
                    {previewMode === 'audio' && (
                        <div className="bg-background rounded-lg p-8 flex flex-col items-center gap-4">
                            <span className="text-sm text-muted-foreground">{subject.name}</span>
                            <audio src={subject.embedUrl} controls autoPlay className="w-80" />
                        </div>
                    )}
                    {previewMode === 'pdf' && (
                        <iframe
                            src={subject.embedUrl}
                            className="w-[80vw] h-[calc(100vh-7rem)] rounded bg-background"
                        />
                    )}
                    {/* Drive and mail serve the same preview shapes; the subject's identity picks the
                        query, and each component calls exactly one hook. */}
                    {previewMode === 'text' && subject.drive && <TextPreviewContent path={subject.drive} />}
                    {previewMode === 'text' && subject.mail && <MailTextPreviewContent part={subject.mail} />}
                    {previewMode === 'vcard' && subject.drive && <VCardPreviewContent path={subject.drive} />}
                    {previewMode === 'vcard' && subject.mail && (
                        <MailVCardPreviewContent part={subject.mail} size={subject.size} />
                    )}
                    {previewMode === 'fallback' && (
                        <div className="flex flex-col items-center gap-4 text-white">
                            {getFileIcon(subject.mimeType, subject.drive?.type ?? 'file', subject.name, {
                                className: 'size-16 text-muted-foreground',
                            })}
                            <span className="text-lg font-medium">{subject.name}</span>
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
                {attachment && downloadableSiblings.length >= 2 && (
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

// Both routes serve one shape, so one renderer reads it — and a mail preview that drifted from the Drive
// one would not compile.
type TextPreviewData = NonNullable<ReturnType<typeof useTextPreview>['data']>;

function TextPreviewBody({ data, isLoading }: { data: TextPreviewData | undefined; isLoading: boolean }) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center w-[80vw] h-[calc(100vh-7rem)]">
                <Loader2 className="size-6 text-white animate-spin" />
            </div>
        );
    }

    if (!data?.body) {
        return (
            <div className="flex items-center justify-center w-[80vw] h-[calc(100vh-7rem)] text-white text-sm text-muted-foreground">
                No preview available
            </div>
        );
    }

    return (
        <div className="w-[80vw] h-[calc(100vh-7rem)] overflow-auto rounded bg-background">
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
                <div className="eigen-prose p-8 max-w-4xl mx-auto" dangerouslySetInnerHTML={{ __html: data.body }} />
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
    // A mail part carries no width/height details, so the box hugs the image once it has loaded: an
    // unmeasured box spans the whole viewport and swallows the clicks that should close the overlay.
    const [loadedRatio, setLoadedRatio] = useState<number>();

    const ratio = aspectRatio ?? loadedRatio;
    const style: React.CSSProperties = ratio
        ? {
              width: `min(90vw, calc((100vh - 7rem) * ${ratio}))`,
              height: `min(calc(100vh - 7rem), calc(90vw / ${ratio}))`,
          }
        : { width: '90vw', height: 'calc(100vh - 7rem)' };

    return (
        <div className="relative" style={style}>
            {/* Thumbnail: always visible until preview is ready */}
            {thumbnailUrl && (
                <img src={thumbnailUrl} alt={alt} className="absolute inset-0 w-full h-full rounded object-contain" />
            )}
            {/* Full preview: loads in background, fades in on top when ready */}
            <img
                key={previewUrl}
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
