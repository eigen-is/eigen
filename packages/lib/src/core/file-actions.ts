import { BookUser, Download, Eye, FileText, FolderDown, MailPlus, Sheet } from 'lucide-react';
import { IMPORT_MAX_BYTES } from '../constants/contact';
import { EML_MAX_BYTES } from '../constants/mail';
import { isEmlFile, isFolderType, isVCardFile } from '../types/drive';
import type { FileAction, FileActionId, FileSubject } from '../types/file-subject';
import { subjectInfo } from './file-subject';

// A convert writes the new document beside its source, so a read-only Drive subject offers nothing.
const canConvert = (subject: FileSubject): boolean => !subject.readOnly;

// What can be done with a file, answered once for every surface; a predicate never asks which menu is drawing.
export const FILE_ACTIONS: readonly FileAction[] = [
    {
        id: 'quick-look',
        label: 'Quick preview',
        icon: Eye,
        applies: (_info, subject) => !subject.drive || !isFolderType(subject.drive.type),
    },
    { id: 'download', label: 'Download', icon: Download, applies: (info) => !!info.downloadUrl },
    {
        id: 'save-to-drive',
        label: 'Save to Drive…',
        icon: FolderDown,
        // A file already at a Drive location has Drive's own Copy to… instead.
        applies: (info, subject) => !!info.downloadUrl && (!subject.drive || !!subject.attachment),
    },
    {
        id: 'convert-to-sheet',
        label: 'Convert to Sheet',
        icon: Sheet,
        // Extension only: the convert route refuses on the name (import-document.ts).
        applies: (info, subject) =>
            !!info.downloadUrl && info.name.toLowerCase().endsWith('.xlsx') && canConvert(subject),
    },
    {
        id: 'convert-to-document',
        label: 'Convert to Document',
        icon: FileText,
        applies: (info, subject) =>
            !!info.downloadUrl && info.name.toLowerCase().endsWith('.docx') && canConvert(subject),
    },
    {
        id: 'import-contacts',
        label: 'Import to Contacts',
        icon: BookUser,
        // Over the ceiling the import 413s, so offer nothing.
        applies: (info) => !!info.downloadUrl && isVCardFile(info.mimeType, info.name) && info.size <= IMPORT_MAX_BYTES,
        guestDenied: true,
    },
    {
        id: 'import-mail',
        label: 'Import to Mail',
        icon: MailPlus,
        applies: (info) => !!info.downloadUrl && isEmlFile(info.mimeType, info.name) && info.size <= EML_MAX_BYTES,
        guestDenied: true,
    },
];

// The rows a guest may not run, read off the registry itself so a new one is covered by declaring it.
export const GUEST_DENIED_ACTIONS: readonly FileActionId[] = FILE_ACTIONS.filter((action) => action.guestDenied).map(
    (action) => action.id,
);

export function fileActionsFor(subject: FileSubject, exclude?: readonly FileActionId[]): FileAction[] {
    const info = subjectInfo(subject);
    return FILE_ACTIONS.filter((action) => !exclude?.includes(action.id) && action.applies(info, subject));
}
