import { triggerDownload } from '@workspace/lib/download';
import { useCopyFiles } from '@workspace/lib/drive';
import { useSaveMailAttachmentsToDrive } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { useEffect, useRef } from 'react';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { DriveLocationPicker } from './drive-location-picker';

type SaveToDrivePickerProps = {
    subjects: FileSubject[];
    open: boolean;
    onClose: () => void;
    // What the save created, for a caller with more to do with it — the runner converts what it
    // just saved for a subject that had no Drive path to convert.
    onSaved?: (paths: DrivePath[]) => void;
    // Overrides the dialog's own wording, for a caller whose save is a step in something larger.
    labels?: { title: string; confirmLabel: string };
};

// One "where does this go" dialog for every surface that puts a file into Drive, with the browser
// download as the escape hatch. A Drive subject is copied server-side, so its bytes never travel; a
// mail part is written from the message the server still holds.
export function SaveToDrivePicker({ subjects, open, onClose, onSaved, labels }: SaveToDrivePickerProps) {
    const preview = useOptionalPreview();
    // Siblings always come from one surface, so a batch is all Drive items or all mail parts: the
    // first subject picks the branch, and the rest ride it.
    const source = subjects[0]?.drive;
    const mail = subjects[0]?.mail;
    // The batch comes from one folder, so every path shares the first one's source mount.
    const copyFiles = useCopyFiles(source?.ownerId ?? '', source?.mountId);
    const saveMailAttachments = useSaveMailAttachmentsToDrive();
    const downloadTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(
        () => () => {
            for (const timer of downloadTimers.current) clearTimeout(timer);
        },
        [],
    );

    // Staggered: a browser drops the second and later downloads of a burst fired in one tick.
    const downloadAll = () => {
        for (const timer of downloadTimers.current) clearTimeout(timer);
        downloadTimers.current = subjects.map((subject, i) =>
            setTimeout(() => {
                if (subject.downloadUrl) triggerDownload(subject.downloadUrl);
            }, i * 300),
        );
    };

    // Neither identity means no branch could write it: better nothing than a dialog that saves 0 files.
    // An empty batch is a picker nothing has opened yet; a closed one keeps its last subjects.
    if (subjects.length > 0 && !mail && !source) return null;

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            // The picker opens over the preview overlay when one is showing, and has to outrank it.
            abovePreview={preview?.isPreviewOpen}
            mode="folder"
            title={labels?.title ?? (subjects.length > 1 ? `Save ${subjects.length} files to Drive` : 'Save to Drive')}
            confirmLabel={labels?.confirmLabel ?? 'Save here'}
            defaultOwnerId={source?.ownerId}
            defaultMountId={source?.mountId}
            onConfirm={async (location) => {
                const target = {
                    targetOwnerId: location.ownerId,
                    targetMountId: location.mountId,
                    targetParentId: location.folderId,
                };
                // Await the write so the picker closes on success and stays open (with the failure
                // toast) on error, instead of closing immediately.
                const saved = mail
                    ? await saveMailAttachments.mutateAsync({
                          messageId: mail.messageId,
                          indexes: subjects.flatMap((subject) => (subject.mail ? [subject.mail.index] : [])),
                          ...target,
                      })
                    : await copyFiles.mutateAsync({
                          pathIds: subjects.flatMap((subject) => (subject.drive ? [subject.drive.id] : [])),
                          ...target,
                      });
                onSaved?.(saved);
            }}
            onDownloadInstead={() => {
                onClose();
                downloadAll();
            }}
        />
    );
}
