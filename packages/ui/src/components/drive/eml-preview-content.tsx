import { EML_MAX_BYTES } from '@workspace/lib/constants/mail';
import { useEmlPreview } from '@workspace/lib/drive';
import { formatFileSize } from '@workspace/lib/format';
import { remainingAttachmentsLine, useMailEmlPreview } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { MailPartRef } from '@workspace/lib/types/file-subject';
import { mailAttachmentName } from '@workspace/lib/types/mail';
import type { EmlPreview } from '@workspace/lib/types/preview';
import { SimpleAttachmentChip } from '../attachment/simple-attachment-chip';
import { MessageView } from '../mail/message-view';
import { PREVIEW_BODY_CLASS, PreviewPane } from './preview-pane';

// The served message, whichever route served it. Drive and mail each have their own component, so exactly
// one query hook runs per render and the overlay picks by the subject it holds.
export function EmlPreviewContent({ path }: { path: DrivePath }) {
    const { data, isPending, isError } = useEmlPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    return <EmlMessage data={data} isPending={isPending} isError={isError} oversize={path.size > EML_MAX_BYTES} />;
}

export function MailEmlPreviewContent({ part, size }: { part: MailPartRef; size: number }) {
    const oversize = size > EML_MAX_BYTES;
    const { data, isPending, isError } = useMailEmlPreview(part.ownerId, part.messageId, part.index, !oversize);
    return <EmlMessage data={data} isPending={isPending} isError={isError} oversize={oversize} />;
}

// Both routes serve one shape, so one renderer reads it.
function EmlMessage({
    data,
    isPending,
    isError,
    oversize,
}: {
    data: EmlPreview | undefined;
    isPending: boolean;
    isError: boolean;
    oversize: boolean;
}) {
    return (
        <PreviewPane oversize={oversize} maxBytes={EML_MAX_BYTES} isPending={isPending} unreadable={isError}>
            {data && (
                <div className={PREVIEW_BODY_CLASS}>
                    <MessageView
                        subject={data.subject}
                        from={data.from}
                        to={data.to}
                        cc={data.cc}
                        date={data.date}
                        html={data.html}
                        text={data.text}
                        attachments={<PreviewAttachments data={data} />}
                    />
                </div>
            )}
        </PreviewPane>
    );
}

// A quick look reads a message, it does not act on it: the parts are named and sized, and nothing else —
// the payload carries no bytes to download or preview.
function PreviewAttachments({ data }: { data: EmlPreview }) {
    if (data.attachments.length === 0) return null;

    return (
        <div className="flex flex-col gap-2 mb-4">
            <div className="flex flex-wrap items-center gap-2">
                {data.attachments.map((att, index) => (
                    <SimpleAttachmentChip
                        key={`${index}-${att.filename ?? ''}`}
                        filename={`${mailAttachmentName(att, index)} · ${formatFileSize(att.size)}`}
                    />
                ))}
            </div>
            {data.remainingAttachments > 0 && (
                <p className="text-sm text-muted-foreground">{remainingAttachmentsLine(data.remainingAttachments)}</p>
            )}
        </div>
    );
}
