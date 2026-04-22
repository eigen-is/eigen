import { useHotkey } from '@tanstack/react-hotkeys';
import { getDriveDownloadUrl, getDriveItemUrl } from '@workspace/lib/api';
import { useCopyFiles, useTextPreview } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FolderDown, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import type { PreviewMode } from '../preview-provider/preview-provider';
import { DriveLocationPicker } from './drive-location-picker';
import { getFileIcon } from './file-icon-helper';

type FilePreviewProps = {
    previewMode: PreviewMode;
    previewUrl: string;
    thumbnailUrl?: string;
    embedUrl: string;
    downloadUrl?: string;
    fileName: string;
    aspectRatio?: number;
    hasPrev: boolean;
    hasNext: boolean;
    path: DrivePath;
    downloadMode: 'direct' | 'save-to-drive';
    siblings: DrivePath[];
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
};

export function FilePreview({
    previewMode,
    previewUrl,
    thumbnailUrl,
    embedUrl,
    downloadUrl,
    fileName,
    aspectRatio,
    hasPrev,
    hasNext,
    path,
    downloadMode,
    siblings,
    onClose,
    onPrev,
    onNext,
}: FilePreviewProps) {
    useHotkey('Escape', () => onClose(), { enabled: true });
    useHotkey(
        'ArrowLeft',
        () => {
            if (hasPrev) onPrev();
        },
        { enabled: true },
    );
    useHotkey(
        'ArrowRight',
        () => {
            if (hasNext) onNext();
        },
        { enabled: true },
    );

    const [locationPickerOpen, setLocationPickerOpen] = useState(false);
    const [locationPickerMode, setLocationPickerMode] = useState<'single' | 'all'>('single');
    const copyFiles = useCopyFiles(path.ownerId, path.mountId);

    const openUrl = getDriveItemUrl(path);

    const downloadAll = () => {
        const downloadable = siblings.filter((s) => !isFolderType(s.type));
        for (let i = 0; i < downloadable.length; i++) {
            const s = downloadable[i];
            setTimeout(() => {
                const a = document.createElement('a');
                a.href = getDriveDownloadUrl(s.ownerId, s.mountId, s.id);
                a.download = '';
                document.body.appendChild(a);
                a.click();
                a.remove();
            }, i * 300);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] bg-black/80 flex flex-col animate-in fade-in" onClick={onClose}>
            {/* Header */}
            <div
                className="flex items-center justify-between px-4 py-2 bg-black/40 text-white shrink-0"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium">{fileName}</span>
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
                        <ProgressiveImage
                            thumbnailUrl={thumbnailUrl}
                            previewUrl={previewUrl}
                            alt={fileName}
                            aspectRatio={aspectRatio}
                        />
                    )}
                    {previewMode === 'video' && (
                        <video
                            src={embedUrl}
                            controls
                            autoPlay
                            className="max-w-full max-h-[calc(100vh-7rem)] rounded"
                            style={aspectRatio ? { aspectRatio: `${aspectRatio}` } : undefined}
                        />
                    )}
                    {previewMode === 'audio' && (
                        <div className="bg-background rounded-lg p-8 flex flex-col items-center gap-4">
                            <span className="text-sm text-muted-foreground">{fileName}</span>
                            <audio src={embedUrl} controls autoPlay className="w-80" />
                        </div>
                    )}
                    {previewMode === 'pdf' && (
                        <iframe src={embedUrl} className="w-[80vw] h-[calc(100vh-7rem)] rounded bg-background" />
                    )}
                    {previewMode === 'text' && <TextPreviewContent path={path} />}
                    {previewMode === 'fallback' && (
                        <div className="flex flex-col items-center gap-4 text-white">
                            {getFileIcon(path.mimeType, path.type, { className: 'size-16 text-muted-foreground' })}
                            <span className="text-lg font-medium">{fileName}</span>
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
                {downloadUrl && downloadMode === 'direct' && (
                    <FooterButton href={downloadUrl} download>
                        <Download className="size-3.5" />
                        Download
                    </FooterButton>
                )}
                {downloadUrl && downloadMode === 'save-to-drive' && (
                    <FooterActionButton
                        onClick={() => {
                            setLocationPickerMode('single');
                            setLocationPickerOpen(true);
                        }}
                    >
                        <Download className="size-3.5" />
                        Save to Drive
                    </FooterActionButton>
                )}
                {siblings.length >= 2 && downloadMode === 'direct' && (
                    <FooterActionButton onClick={downloadAll}>
                        <FolderDown className="size-3.5" />
                        Download all ({siblings.filter((s) => !isFolderType(s.type)).length})
                    </FooterActionButton>
                )}
                {siblings.length >= 2 && downloadMode === 'save-to-drive' && (
                    <FooterActionButton
                        onClick={() => {
                            setLocationPickerMode('all');
                            setLocationPickerOpen(true);
                        }}
                    >
                        <FolderDown className="size-3.5" />
                        Save all to Drive ({siblings.filter((s) => !isFolderType(s.type)).length})
                    </FooterActionButton>
                )}
            </div>
            {downloadMode === 'save-to-drive' && (
                <DriveLocationPicker
                    open={locationPickerOpen}
                    onOpenChange={setLocationPickerOpen}
                    abovePreview
                    mode="folder"
                    title={locationPickerMode === 'all' ? 'Save all to Drive' : 'Save to Drive'}
                    confirmLabel="Save here"
                    defaultOwnerId={path.ownerId}
                    defaultMountId={path.mountId}
                    onConfirm={(location) => {
                        const pathIds =
                            locationPickerMode === 'all'
                                ? siblings.filter((s) => !isFolderType(s.type)).map((s) => s.id)
                                : [path.id];
                        copyFiles.mutate({
                            pathIds,
                            targetOwnerId: location.ownerId,
                            targetMountId: location.mountId,
                            targetParentId: location.folderId,
                        });
                    }}
                    onDownloadInstead={() => {
                        setLocationPickerOpen(false);
                        if (locationPickerMode === 'all') {
                            downloadAll();
                        } else if (downloadUrl) {
                            const a = document.createElement('a');
                            a.href = downloadUrl;
                            a.download = '';
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                        }
                    }}
                />
            )}
        </div>
    );
}

function TextPreviewContent({ path }: { path: DrivePath }) {
    const { data, isLoading } = useTextPreview(path.ownerId, path.mountId, path.id, true);

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
                        className="w-full max-w-[960px] mx-auto flex flex-col gap-4 [&>.slide]:w-full [&>.slide]:rounded [&>.slide]:shadow-md"
                        dangerouslySetInnerHTML={{ __html: data.body }}
                    />
                </div>
            ) : data.mode === 'eigensheets' ? (
                <div className="p-8 min-h-full">
                    <div className="eigensheets-preview mx-auto" dangerouslySetInnerHTML={{ __html: data.body }} />
                </div>
            ) : (
                <div
                    className="eigen-prose p-8 max-w-[52rem] mx-auto"
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

    const style: React.CSSProperties = aspectRatio
        ? {
              width: `min(90vw, calc((100vh - 7rem) * ${aspectRatio}))`,
              height: `min(calc(100vh - 7rem), calc(90vw / ${aspectRatio}))`,
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
                onLoad={() => setPreviewReady(true)}
            />
        </div>
    );
}

function FooterButton({ href, download, children }: { href: string; download?: boolean; children: React.ReactNode }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            download={download || undefined}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm transition-colors"
        >
            {children}
        </a>
    );
}

function FooterActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm transition-colors"
        >
            {children}
        </button>
    );
}
