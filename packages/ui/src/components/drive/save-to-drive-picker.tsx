// One "where does this go" dialog for every surface that puts a file into Drive, such as an attachment
// menu or a file preview, with the browser download as the escape hatch. A Drive item is copied on the
// server, and a mail part is written from the stored message.

import { useAuth } from '@workspace/lib/auth';
import { triggerDownload } from '@workspace/lib/download';
import { PartialBatchError, useCopyToFolder } from '@workspace/lib/drive';
import { subjectInfo } from '@workspace/lib/file-subject';
import { useMyTeams } from '@workspace/lib/home';
import { useSaveMailAttachmentsToDrive } from '@workspace/lib/mail';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { useEffect, useRef } from 'react';
import { DriveLocationPicker } from './drive-location-picker';

type SaveToDrivePickerProps = {
    subjects: readonly FileSubject[];
    open: boolean;
    onClose: () => void;
    // What the save created: the runner converts what it just saved for a subject with no Drive path.
    onSaved?: (paths: DrivePath[]) => void;
    // The picker stays open after a partial failure, and its owner narrows subjects to the failed ones for a retry.
    onPartialFailure: (failed: FileSubject[]) => void;
    // For a caller whose save is a step in something larger (a convert).
    title?: string;
    confirmLabel?: string;
};

export function SaveToDrivePicker({
    subjects,
    open,
    onClose,
    onSaved,
    onPartialFailure,
    title,
    confirmLabel,
}: SaveToDrivePickerProps) {
    // Siblings come from one surface, so a batch is all Drive items or all mail parts: the first picks the branch.
    const source = subjects[0]?.drive;
    const mail = subjects[0]?.mail;
    const { user } = useAuth();
    const { data: myTeams } = useMyTeams();
    // A sharee cannot write to the source's drive, so the picker starts there only when it is the viewer's or a team's.
    const startsAtSource =
        source?.ownerId === user?.id || !!myTeams?.some((team) => teamOwnerId(team.id) === source?.ownerId);
    const { mutateAsync: copyToFolder } = useCopyToFolder();
    const saveMailAttachments = useSaveMailAttachmentsToDrive();
    const items = subjects.flatMap((subject) => (subject.drive ? [subject.drive] : []));
    const count = subjects.length;
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
                const { downloadUrl } = subjectInfo(subject);
                if (downloadUrl) triggerDownload(downloadUrl);
            }, i * 300),
        );
    };

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            mode="folder"
            title={title ?? (count > 1 ? `Save ${count} files to Drive` : 'Save to Drive')}
            confirmLabel={confirmLabel ?? 'Save here'}
            defaultOwnerId={startsAtSource ? source?.ownerId : undefined}
            defaultMountId={startsAtSource ? source?.mountId : undefined}
            onConfirm={async (location) => {
                const target = {
                    targetOwnerId: location.ownerId,
                    targetMountId: location.mountId,
                    targetParentId: location.folderId,
                };
                // Awaited so the picker closes on success and stays open, with the failure toast, on error.
                const saved = mail
                    ? await saveMailAttachments.mutateAsync({
                          messageId: mail.messageId,
                          indexes: subjects.flatMap((subject) => (subject.mail ? [subject.mail.index] : [])),
                          ...target,
                      })
                    : await copyToFolder({ items, ...target }).catch((error: unknown) => {
                          if (error instanceof PartialBatchError) {
                              onPartialFailure(
                                  subjects.filter((subject) => subject.drive && error.failed.includes(subject.drive)),
                              );
                          }
                          throw error;
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
