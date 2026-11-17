// Quick look: one file of a list, such as a Drive item or a mail attachment, in the quick preview lightbox, which
// pages through its siblings. It picks a body by the file's preview mode: an image, a video, a PDF, or a text preview
// the server rendered, such as a doc drawn on its paper. Its footer holds Open and the file's actions, which come from
// the shared file action registry.

import { getDriveItemUrl, getDrivePreviewUrl } from '@workspace/lib/api';
import { DEFAULT_PAGE_SETUP, DOC_PROSE_CLASS, normalStyleProperties, pageBoxStyle } from '@workspace/lib/docs/eigendoc';
import { useTextPreview } from '@workspace/lib/drive';
import { getPreviewMode, subjectInfo } from '@workspace/lib/file-subject';
import { useMailTextPreview } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject, MailPartRef } from '@workspace/lib/types/file-subject';
import type { TextPreviewResult } from '@workspace/lib/types/preview';
import { cn, IMAGE_CHECKERBOARD_STYLE } from '@workspace/ui/lib/utils';
import { ArrowRight, FolderDown } from 'lucide-react';
import { useState } from 'react';
import { EigenLoader } from '../braket/eigen-loader';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { PREVIEW_BODY_MAX_HEIGHT, PreviewLightbox } from '../preview-lightbox';
import { EmlPreviewContent, MailEmlPreviewContent } from './eml-preview-content';
import { getFileIcon } from './file-presentation';
import { IcsPreviewContent, MailIcsPreviewContent } from './ics-preview-content';
import { PREVIEW_PANE_CLASS } from './preview-pane';
import { MailVCardPreviewContent, VCardPreviewContent } from './vcard-preview-content';

type FilePreviewProps = {
    subject: FileSubject;
    siblings: FileSubject[];
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
};

export function FilePreview({ subject, siblings, onClose, onPrev, onNext }: FilePreviewProps) {
    // The overlay is Quick Look itself, so the registry's own row is the one it drops.
    const runner = useFileActionRunner(subject, siblings, ['quick-look']);
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

    const openUrl = drive ? getDriveItemUrl(drive) : undefined;
    const downloadableSiblings = siblings.filter((sibling) => !!subjectInfo(sibling).downloadUrl);

    return (
        <PreviewLightbox
            title={info.name}
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrev={onPrev}
            onNext={onNext}
            onClose={onClose}
            footer={
                <>
                    {openUrl && (
                        <FooterButton href={openUrl}>
                            <ArrowRight className="size-3.5" />
                            Open
                        </FooterButton>
                    )}
                    {runner.actions.map((action) => (
                        <FooterActionButton
                            key={action.id}
                            onClick={() => runner.run(action)}
                            disabled={runner.isPending}
                        >
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
                    {runner.dialogs}
                </>
            }
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
                    className="max-w-full rounded"
                    style={{
                        maxHeight: PREVIEW_BODY_MAX_HEIGHT,
                        aspectRatio: aspectRatio ? `${aspectRatio}` : undefined,
                    }}
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
            {/* A Drive item and a mail part preview alike. Each loads through its own hook, so each
                                has its own component. */}
            {previewMode === 'text' && drive && <TextPreviewContent path={drive} />}
            {previewMode === 'text' && subject.mail && <MailTextPreviewContent part={subject.mail} />}
            {previewMode === 'vcard' && drive && <VCardPreviewContent path={drive} />}
            {previewMode === 'vcard' && subject.mail && (
                <MailVCardPreviewContent part={subject.mail} size={info.size} />
            )}
            {previewMode === 'eml' && drive && <EmlPreviewContent path={drive} />}
            {previewMode === 'eml' && subject.mail && <MailEmlPreviewContent part={subject.mail} size={info.size} />}
            {previewMode === 'ics' && drive && <IcsPreviewContent path={drive} />}
            {previewMode === 'ics' && subject.mail && <MailIcsPreviewContent part={subject.mail} size={info.size} />}
            {previewMode === 'fallback' && (
                <div className="flex flex-col items-center gap-4 text-white">
                    {getFileIcon(info.mimeType, drive?.type ?? 'file', info.name, {
                        className: 'size-16 text-muted-foreground',
                    })}
                    <span className="text-lg font-medium">{info.name}</span>
                    <span className="text-sm text-muted-foreground">No preview available</span>
                </div>
            )}
        </PreviewLightbox>
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
                <EigenLoader className="text-2xl text-white" />
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
                // eigen-paper draws the page light, as the editor does, and keeps the dark theme's rules off the prose.
                // `isolate` keeps a figure set behind the text on the paper, and `overflow-hidden` cuts one placed past
                // the paper's edge.
                <div
                    className="eigen-paper mx-auto bg-background isolate overflow-hidden"
                    style={{
                        ...pageBoxStyle(data.page ?? DEFAULT_PAGE_SETUP),
                        ...(data.style && normalStyleProperties(data.style)),
                    }}
                >
                    <div
                        className={cn('eigen-prose tiptap', DOC_PROSE_CLASS)}
                        dangerouslySetInnerHTML={{ __html: data.body }}
                    />
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
    // Once the ratio is known, the box is exactly the image area, so the checkerboard sits only behind the image.
    // That keeps transparent line art readable on the dark backdrop.
    const style: React.CSSProperties = ratio
        ? {
              width: `min(90vw, calc(${PREVIEW_BODY_MAX_HEIGHT} * ${ratio}))`,
              height: `min(${PREVIEW_BODY_MAX_HEIGHT}, calc(90vw / ${ratio}))`,
              ...IMAGE_CHECKERBOARD_STYLE,
          }
        : { width: '90vw', height: PREVIEW_BODY_MAX_HEIGHT };

    return (
        <div className="relative rounded" style={style}>
            {/* The thumbnail fades out only after the preview has faded in over it, because fading both at once lets
                the checkerboard flash through. It can't stay underneath either: its upscaled edges would show through
                the transparent parts of an SVG or PNG. */}
            {thumbnailUrl && (
                <img
                    src={thumbnailUrl}
                    alt={alt}
                    className="absolute inset-0 w-full h-full rounded object-contain transition-opacity duration-300 delay-300"
                    style={{ opacity: previewReady ? 0 : 1 }}
                />
            )}
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

// An anchor rather than a button, so a Cmd-click or a middle click opens the file in a new tab.
function FooterButton({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a
            href={href}
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
