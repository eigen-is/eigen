import { getMailAttachmentUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useSaveMailAttachmentsToDrive } from '@workspace/lib/mail';
import type { Attachment } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/button';
import { SimpleAttachmentChip } from '@workspace/ui/components/layout/attachment';
import { DriveLocationPicker } from '@workspace/ui/components/layout/drive/drive-location-picker';
import { Download, HardDriveDownload } from 'lucide-react';
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

    const handleDownloadAll = () => {
        visible.forEach(({ att, index }, i) => {
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
            <div className="flex flex-wrap items-center gap-2 mb-4">
                {visible.map(({ att, index }) => {
                    const filename = att.filename || `Attachment ${index + 1}`;
                    return (
                        <SimpleAttachmentChip
                            key={index}
                            filename={filename}
                            downloadUrl={getMailAttachmentUrl(user.id, emailId, index, filename)}
                        />
                    );
                })}
                {visible.length >= 2 && (
                    <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={handleDownloadAll}>
                            <Download className="h-3 w-3 mr-1" />
                            Download all
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7"
                            onClick={() => handleSaveToDrive(visible.map(({ index }) => index))}
                        >
                            <HardDriveDownload className="h-3 w-3 mr-1" />
                            Save all to Drive
                        </Button>
                    </div>
                )}
            </div>
            <DriveLocationPicker
                open={savePickerOpen}
                onOpenChange={setSavePickerOpen}
                mode="folder"
                title={saveIndexes.length === 1 ? 'Save attachment' : 'Save attachments'}
                confirmLabel="Save here"
                onConfirm={({ ownerId, mountId, folderId }) => {
                    saveMutation.mutate({
                        messageId: emailId,
                        indexes: saveIndexes,
                        targetOwnerId: ownerId,
                        targetMountId: mountId,
                        targetParentId: folderId,
                    });
                    setSavePickerOpen(false);
                }}
                onDownloadInstead={() => {
                    setSavePickerOpen(false);
                    handleDownloadAll();
                }}
            />
        </>
    );
}
