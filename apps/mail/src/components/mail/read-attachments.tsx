import { getMailAttachmentUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useSaveMailAttachmentsToDrive } from '@workspace/lib/mail';
import type { Attachment } from '@workspace/lib/types/mail';
import { TooltipButton } from '@workspace/ui';
import { SimpleAttachmentChip } from '@workspace/ui/components/attachment';
import { DriveLocationPicker } from '@workspace/ui/components/drive';
import { Download } from 'lucide-react';
import { useState } from 'react';

type ReadAttachmentsProps = {
    emailId: string;
    attachments: Attachment[] | undefined;
};

export function ReadAttachments({ emailId, attachments }: ReadAttachmentsProps) {
    const { user } = useAuth();
    const [savePickerOpen, setSavePickerOpen] = useState(false);
    const [saveIndexes, setSaveIndexes] = useState<number[]>([]);
    const saveMutation = useSaveMailAttachmentsToDrive();

    if (!user || !attachments?.length) return null;

    const visible = attachments
        .map((att, index) => ({ att, index }))
        .filter(({ att }) => !att.contentType.startsWith('text/calendar'));
    if (visible.length === 0) return null;

    const handleSaveToDrive = (indexes: number[]) => {
        setSaveIndexes(indexes);
        setSavePickerOpen(true);
    };

    const handleDownloadAll = (indexes?: number[]) => {
        const toDownload = indexes ? visible.filter(({ index }) => indexes.includes(index)) : visible;
        // Stagger clicks so the browser treats each as a separate download, not a popup.
        toDownload.forEach(({ att, index }, i) => {
            const filename = att.filename || `attachment-${index}`;
            const url = getMailAttachmentUrl(user.id, emailId, index, filename);
            setTimeout(() => {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
            }, i * 300);
        });
    };

    return (
        <>
            <div className="flex items-center gap-2 mb-4">
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                    {visible.map(({ att, index }) => {
                        const filename = att.filename || `Attachment ${index + 1}`;
                        return (
                            <SimpleAttachmentChip
                                key={index}
                                filename={filename}
                                downloadUrl={getMailAttachmentUrl(user.id, emailId, index, filename)}
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleSaveToDrive([index]);
                                }}
                            />
                        );
                    })}
                </div>
                <TooltipButton
                    icon={Download}
                    tooltipText={visible.length === 1 ? 'Save attachment' : 'Save attachments'}
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleSaveToDrive(visible.map(({ index }) => index))}
                />
            </div>
            <DriveLocationPicker
                open={savePickerOpen}
                onOpenChange={setSavePickerOpen}
                mode="folder"
                title={saveIndexes.length === 1 ? 'Save attachment' : 'Save attachments'}
                confirmLabel="Save here"
                onConfirm={async ({ ownerId, mountId, folderId }) => {
                    await saveMutation.mutateAsync({
                        messageId: emailId,
                        indexes: saveIndexes,
                        targetOwnerId: ownerId,
                        targetMountId: mountId,
                        targetParentId: folderId,
                    });
                }}
                onDownloadInstead={() => {
                    setSavePickerOpen(false);
                    handleDownloadAll(saveIndexes);
                }}
            />
        </>
    );
}
