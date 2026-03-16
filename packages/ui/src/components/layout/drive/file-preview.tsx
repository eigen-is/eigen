import {useHotkey} from "@tanstack/react-hotkeys";
import {ChevronLeft, ChevronRight, Download, ExternalLink, X} from "lucide-react";
import type {DrivePath} from "@workspace/lib/types/drive";
import {isDocumentType, isInlineEditable} from "@workspace/lib/types/drive";
import {getDocumentUrl, getInlineEditUrl} from "@workspace/lib/api";
import {getFileIcon} from "./file-icon-helper";
import type {PreviewMode} from "../preview-provider/preview-provider";

interface FilePreviewProps {
    previewMode: PreviewMode;
    previewUrl: string;
    embedUrl: string;
    downloadUrl?: string;
    fileName: string;
    mimeType: string;
    aspectRatio?: number;
    hasPrev: boolean;
    hasNext: boolean;
    path: DrivePath;
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
}

export function FilePreview({
                                previewMode, previewUrl, embedUrl, downloadUrl,
                                fileName, aspectRatio, hasPrev, hasNext, path,
                                onClose, onPrev, onNext,
                            }: FilePreviewProps) {
    useHotkey('Escape', () => onClose(), {enabled: true});
    useHotkey('ArrowLeft', () => {
        if (hasPrev) onPrev();
    }, {enabled: true});
    useHotkey('ArrowRight', () => {
        if (hasNext) onNext();
    }, {enabled: true});

    const openUrl = isDocumentType(path.type)
        ? getDocumentUrl(path) || undefined
        : isInlineEditable(path.mimeType, path.name)
            ? getInlineEditUrl(path.ownerId, path.mountId, path.id)
            : undefined;

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/80 flex flex-col animate-in fade-in"
            onClick={onClose}
        >
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
                        <ChevronLeft className="size-4"/>
                    </NavButton>
                    <NavButton onClick={onNext} disabled={!hasNext} title="Next (→)">
                        <ChevronRight className="size-4"/>
                    </NavButton>
                    <NavButton onClick={onClose} title="Close (Esc)">
                        <X className="size-4"/>
                    </NavButton>
                </div>
            </div>

            {/* Content */}
            <div
                className="flex-1 flex items-center justify-center overflow-hidden min-h-0"
                onClick={onClose}
                style={{cursor: "zoom-out"}}
            >
                <div
                    className="max-w-[90vw] max-h-[calc(100vh-7rem)] flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                    style={{cursor: "default"}}
                >
                    {previewMode === 'image' && (
                        <img
                            src={previewUrl}
                            alt={fileName}
                            className="max-w-full max-h-[calc(100vh-7rem)] rounded object-contain"
                            style={aspectRatio ? {aspectRatio: `${aspectRatio}`} : undefined}
                        />
                    )}
                    {previewMode === 'video' && (
                        <video
                            src={embedUrl}
                            controls
                            autoPlay
                            className="max-w-full max-h-[calc(100vh-7rem)] rounded"
                            style={aspectRatio ? {aspectRatio: `${aspectRatio}`} : undefined}
                        />
                    )}
                    {previewMode === 'audio' && (
                        <div className="bg-background rounded-lg p-8 flex flex-col items-center gap-4">
                            <span className="text-sm text-muted-foreground">{fileName}</span>
                            <audio src={embedUrl} controls autoPlay className="w-80"/>
                        </div>
                    )}
                    {previewMode === 'pdf' && (
                        <iframe
                            src={embedUrl}
                            className="w-[80vw] h-[calc(100vh-7rem)] rounded bg-background"
                        />
                    )}
                    {previewMode === 'html' && (
                        <iframe
                            src={previewUrl}
                            sandbox="allow-same-origin"
                            className="w-[80vw] h-[calc(100vh-7rem)] rounded bg-white"
                        />
                    )}
                    {previewMode === 'fallback' && (
                        <div className="flex flex-col items-center gap-4 text-white">
                            {getFileIcon(path.mimeType, path.type, {className: "size-16 text-muted-foreground"})}
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
                        <ExternalLink className="size-3.5"/>
                        Open
                    </FooterButton>
                )}
                {downloadUrl && (
                    <FooterButton href={downloadUrl} download>
                        <Download className="size-3.5"/>
                        Download
                    </FooterButton>
                )}
            </div>
        </div>
    );
}

function NavButton({onClick, disabled, title, children}: {
    onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode;
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

function FooterButton({href, download, children}: {
    href: string; download?: boolean; children: React.ReactNode;
}) {
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
