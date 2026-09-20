import { openDocument } from '@workspace/lib/api';
import { useImportContactsFromDrive, useImportContactsFromUrl } from '@workspace/lib/contacts';
import { triggerDownload } from '@workspace/lib/download';
import { useConvertDocument } from '@workspace/lib/drive';
import { subjectInfo } from '@workspace/lib/file-subject';
import { useImportMailFromDrive, useImportMailFromUrl } from '@workspace/lib/mail';
import type { ConvertTarget, DrivePath } from '@workspace/lib/types/drive';
import type { FileAction, FileActionId, FileSubject } from '@workspace/lib/types/file-subject';
import { type ReactNode, useState } from 'react';
import { ProgressDialog } from '../drive/progress-dialog';
import { SaveToDrivePicker } from '../drive/save-to-drive-picker';
import { usePreview } from '../preview-provider/preview-context';
import { useFileActions } from './use-file-actions';

export type FileActionRunner = {
    // The menu draws its rows from the subject the runner acts on, so a host can never pair two.
    subject: FileSubject | null;
    // The rows to draw for this subject and this viewer, the host's own exclusions already dropped.
    actions: FileAction[];
    run: (action: FileAction) => void;
    // For a host with a set of its own to save: the overlay's "Save all" row.
    openPicker: (subjects: FileSubject[]) => void;
    // Rendered once by the host, so a picker opened from a menu row outlives the menu that closed.
    dialogs: ReactNode;
    isDialogOpen: boolean;
    isPending: boolean;
};

// A convert on a subject with nothing in Drive to convert saves first; the label names the row that asked.
type PickerState = { subjects: FileSubject[]; convert?: { targetType: ConvertTarget; label: string } };

// What every import-from-drive route takes: the file to read, not where it lands.
type DriveSource = { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };

// A host whose subject is state (the right-clicked chip or row) passes null while there is none;
// `exclude` drops a row the host draws itself (the overlay is Quick Look, so it drops that one).
export function useFileActionRunner(
    subject: FileSubject | null,
    siblings?: FileSubject[],
    exclude?: readonly FileActionId[],
): FileActionRunner {
    const { openPreview } = usePreview();
    const convertDocument = useConvertDocument();
    const importContactsFromDrive = useImportContactsFromDrive();
    const importContactsFromUrl = useImportContactsFromUrl();
    const importMailFromDrive = useImportMailFromDrive();
    const importMailFromUrl = useImportMailFromUrl();
    const actions = useFileActions(subject, exclude);
    // Open is its own flag: the closed picker keeps its subjects so its title holds through the exit animation.
    const [picker, setPicker] = useState<PickerState>({ subjects: [] });
    const [pickerOpen, setPickerOpen] = useState(false);

    const openPicker = (subjects: FileSubject[], convert?: PickerState['convert']) => {
        if (subjects.length === 0) return;
        setPicker({ subjects, convert });
        setPickerOpen(true);
    };

    const convertPath = (path: DrivePath, targetType: ConvertTarget) => {
        if (!path.parentId) return;
        convertDocument.mutate(
            { ownerId: path.ownerId, mountId: path.mountId, pathId: path.id, parentId: path.parentId, targetType },
            { onSuccess: (newPath) => openDocument(newPath) },
        );
    };

    const convert = (targetType: ConvertTarget, label: string) => {
        if (!subject) return;
        if (!subject.drive || subject.attachment) openPicker([subject], { targetType, label });
        else convertPath(subject.drive, targetType);
    };

    // Every import reads the same way: a file at a Drive location is copied server-side, anything else
    // hands the route the bytes behind its download URL. Only the pair of hooks differs per format.
    const runImport = (fromDrive: (source: DriveSource) => void, fromUrl: (input: { url: string }) => void) => {
        if (!subject) return;
        const { drive } = subject;
        if (drive) {
            fromDrive({ sourceOwnerId: drive.ownerId, sourceMountId: drive.mountId, sourcePathId: drive.id });
            return;
        }
        const { downloadUrl } = subjectInfo(subject);
        if (!downloadUrl) return;
        fromUrl({ url: downloadUrl });
    };

    const run = (action: FileAction) => {
        if (!subject) return;
        switch (action.id) {
            case 'quick-look':
                openPreview(subject, siblings);
                return;
            case 'download': {
                const { downloadUrl } = subjectInfo(subject);
                if (downloadUrl) triggerDownload(downloadUrl);
                return;
            }
            case 'save-to-drive':
                openPicker([subject]);
                return;
            case 'convert-to-sheet':
                convert('eigensheets', action.label);
                return;
            case 'convert-to-document':
                convert('eigendoc', action.label);
                return;
            case 'import-contacts':
                runImport(importContactsFromDrive.mutate, importContactsFromUrl.mutate);
                return;
            case 'import-mail':
                runImport(importMailFromDrive.mutate, importMailFromUrl.mutate);
                return;
        }
    };

    return {
        subject,
        actions,
        run,
        openPicker,
        // Mounted while closed: "Download instead" fires staggered downloads from timers the picker clears on unmount.
        dialogs: (
            <>
                <SaveToDrivePicker
                    subjects={picker.subjects}
                    open={pickerOpen}
                    title={picker.convert?.label}
                    confirmLabel={picker.convert && 'Save and convert'}
                    onClose={() => setPickerOpen(false)}
                    onSaved={(paths) => {
                        if (picker.convert) for (const path of paths) convertPath(path, picker.convert.targetType);
                    }}
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
        isDialogOpen: pickerOpen || convertDocument.isPending,
        isPending:
            convertDocument.isPending ||
            importContactsFromDrive.isPending ||
            importContactsFromUrl.isPending ||
            importMailFromDrive.isPending ||
            importMailFromUrl.isPending,
    };
}
