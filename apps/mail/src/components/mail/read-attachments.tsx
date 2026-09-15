import { useAuth } from '@workspace/lib/auth';
import { subjectFromMailAttachment, subjectInfo } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { type Attachment, isCalendarPart } from '@workspace/lib/types/mail';
import { TooltipButton } from '@workspace/ui';
import { SimpleAttachmentChip, useAttachmentChipMenu } from '@workspace/ui/components/attachment';
import { ContextMenuAnchor } from '@workspace/ui/components/context-menu';
import { FileActionMenuItems, useFileActionRunner } from '@workspace/ui/components/file-actions';
import { usePreview } from '@workspace/ui/components/preview-provider';
import { Download } from 'lucide-react';
import { useCallback, useMemo } from 'react';

type ReadAttachmentsProps = {
    emailId: string;
    attachments: Attachment[] | undefined;
};

export function ReadAttachments({ emailId, attachments }: ReadAttachmentsProps) {
    const { user } = useAuth();
    const { openPreview } = usePreview();
    const ownerId = user?.id ?? '';

    // Calendar parts belong to the invite widget, not to the chip row, but each subject keeps the raw
    // part index the mail routes address — so hiding one never shifts the others.
    const subjects = useMemo(
        () =>
            (attachments ?? [])
                .filter((att) => !isCalendarPart(att))
                .map((att) => subjectFromMailAttachment(ownerId, emailId, att.index, att)),
        [attachments, emailId, ownerId],
    );
    // Each chip's derived facts once: the key a press resolves through, the name and the byte URL.
    const chips = useMemo(() => subjects.map((subject) => ({ subject, info: subjectInfo(subject) })), [subjects]);
    const chipSubject = useCallback(
        (key: string | null) => chips.find((chip) => chip.info.key === key)?.subject,
        [chips],
    );
    const { contextMenu, bind } = useAttachmentChipMenu<FileSubject>(chipSubject);
    // The message's own parts are the siblings, so a quick look from here pages through them and
    // keeps its "Save all" row.
    const runner = useFileActionRunner(contextMenu.item, subjects);

    if (!user || subjects.length === 0) return null;

    return (
        <div className="flex items-center gap-2 mb-4" {...bind()}>
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                {chips.map(({ subject, info }) => (
                    <SimpleAttachmentChip
                        key={info.key}
                        attachmentKey={info.key}
                        filename={info.name}
                        downloadUrl={info.downloadUrl}
                        onClick={(e) => {
                            e.preventDefault();
                            openPreview(subject, subjects);
                        }}
                    />
                ))}
            </div>
            <TooltipButton
                icon={Download}
                tooltipText={subjects.length === 1 ? 'Save attachment' : 'Save attachments'}
                className="h-7 w-7 shrink-0"
                onClick={() => runner.openPicker(subjects)}
            />
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
                <FileActionMenuItems runner={runner} />
            </ContextMenuAnchor>
            {runner.dialogs}
        </div>
    );
}
