import { openDocument } from '@workspace/lib/api';
import { onMutationError } from '@workspace/lib/api-error';
import { useImportContacts, useImportContactsFromDrive } from '@workspace/lib/contacts';
import { triggerDownload } from '@workspace/lib/download';
import { useConvertDocument } from '@workspace/lib/drive';
import type { FileAction } from '@workspace/lib/file-actions';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { type ReactNode, useState } from 'react';
import { ProgressDialog } from '../drive/progress-dialog';
import { SaveToDrivePicker } from '../drive/save-to-drive-picker';
import { type PreviewOptions, usePreview } from '../preview-provider/preview-context';

export type FileActionRunner = {
    // The menu component draws the rows from the same subject the runner acts on, so a host can
    // never pair one with another's.
    subject: FileSubject | null;
    run: (action: FileAction) => void;
    // For a host with a batch of its own to save — the overlay's "Save all" row.
    openPicker: (subjects: FileSubject[]) => void;
    // Rendered once by the host, so a picker opened from any row lives outside the menu that closed.
    dialogs: ReactNode;
    isDialogOpen: boolean;
    isPending: boolean;
};

// A host whose subject is state — the right-clicked chip or row — passes null while there is none.
export function useFileActionRunner(
    subject: FileSubject | null,
    siblings?: FileSubject[],
    options?: PreviewOptions,
): FileActionRunner {
    const { openPreview } = usePreview();
    const convertDocument = useConvertDocument();
    const importContactsFromDrive = useImportContactsFromDrive();
    const importContacts = useImportContacts();
    const [pickerSubjects, setPickerSubjects] = useState<FileSubject[] | null>(null);

    const convert = (targetType: 'eigensheets' | 'eigendoc') => {
        const drive = subject?.drive;
        // A later unit saves a non-Drive subject to Drive first, then converts what it saved.
        if (!drive?.parentId) return;
        convertDocument.mutate(
            {
                ownerId: drive.ownerId,
                mountId: drive.mountId,
                pathId: drive.id,
                parentId: drive.parentId,
                targetType,
            },
            { onSuccess: (newPath) => openDocument(newPath) },
        );
    };

    const runImportContacts = () => {
        if (!subject) return;
        const { drive, downloadUrl } = subject;
        if (drive) {
            importContactsFromDrive.mutate({
                sourceOwnerId: drive.ownerId,
                sourceMountId: drive.mountId,
                sourcePathId: drive.id,
            });
            return;
        }
        if (!downloadUrl) return;
        // No Drive path to read server-side: a vCard is kilobytes, so the browser carries the bytes.
        fetch(downloadUrl, { credentials: 'include' })
            .then(async (response) => {
                if (!response.ok) throw new Error(await response.text());
                return new File([await response.blob()], subject.name, { type: subject.mimeType });
            })
            .then((file) => importContacts.mutate(file))
            .catch(onMutationError);
    };

    const run = (action: FileAction) => {
        if (!subject) return;
        switch (action.id) {
            case 'quick-look':
                openPreview(subject, siblings, options);
                return;
            case 'download':
                if (subject.downloadUrl) triggerDownload(subject.downloadUrl);
                return;
            case 'save-to-drive':
                setPickerSubjects([subject]);
                return;
            case 'convert-to-sheet':
                convert('eigensheets');
                return;
            case 'convert-to-document':
                convert('eigendoc');
                return;
            case 'import-contacts':
                runImportContacts();
                return;
        }
    };

    return {
        subject,
        run,
        openPicker: setPickerSubjects,
        // Mounted while closed: the picker's "Download instead" fires staggered downloads from timers
        // it clears when it unmounts.
        dialogs: (
            <>
                <SaveToDrivePicker
                    subjects={pickerSubjects ?? []}
                    open={pickerSubjects !== null}
                    onClose={() => setPickerSubjects(null)}
                />
                <ProgressDialog
                    open={convertDocument.isPending}
                    title={
                        convertDocument.variables?.targetType === 'eigendoc'
                            ? 'Converting to document'
                            : 'Converting to sheet'
                    }
                />
            </>
        ),
        isDialogOpen: pickerSubjects !== null,
        isPending: convertDocument.isPending || importContactsFromDrive.isPending || importContacts.isPending,
    };
}
