import { BookUser, Download, Eye, FileText, FolderDown, type LucideIcon, Sheet } from 'lucide-react';
import { IMPORT_MAX_BYTES } from '../constants/contact';
import { isFolderType, isVCardFile } from '../types/drive';
import type { FileSubject } from '../types/file-subject';

export type FileActionId =
    | 'quick-look'
    | 'download'
    | 'save-to-drive'
    | 'convert-to-sheet'
    | 'convert-to-document'
    | 'import-contacts';

export type FileAction = {
    id: FileActionId;
    label: string;
    icon: LucideIcon;
    applies: (subject: FileSubject) => boolean;
};

// What can be done with a file, answered once for every surface. A predicate reads the subject's own
// type and size, never which menu is asking. Order here is the order rows are drawn in.
export const FILE_ACTIONS: readonly FileAction[] = [
    {
        id: 'quick-look',
        label: 'Quick preview',
        icon: Eye,
        applies: (subject) => !subject.drive || !isFolderType(subject.drive.type),
    },
    { id: 'download', label: 'Download', icon: Download, applies: (subject) => !!subject.downloadUrl },
    { id: 'save-to-drive', label: 'Save to Drive…', icon: FolderDown, applies: (subject) => !!subject.downloadUrl },
    {
        id: 'convert-to-sheet',
        label: 'Convert to Sheet',
        icon: Sheet,
        // Extension only, matching the server: import-document.ts refuses on the name, so a mail part
        // carrying the mime but no extension would offer a row that 400s.
        applies: (subject) => !!subject.downloadUrl && subject.name.toLowerCase().endsWith('.xlsx'),
    },
    {
        id: 'convert-to-document',
        label: 'Convert to Document',
        icon: FileText,
        applies: (subject) => !!subject.downloadUrl && subject.name.toLowerCase().endsWith('.docx'),
    },
    {
        id: 'import-contacts',
        label: 'Import to Contacts',
        icon: BookUser,
        // Over the ceiling the import itself 413s — offer nothing to click.
        applies: (subject) =>
            !!subject.downloadUrl && isVCardFile(subject.mimeType, subject.name) && subject.size <= IMPORT_MAX_BYTES,
    },
];

export function fileActionsFor(subject: FileSubject, exclude?: readonly FileActionId[]): FileAction[] {
    return FILE_ACTIONS.filter((action) => !exclude?.includes(action.id) && action.applies(subject));
}
