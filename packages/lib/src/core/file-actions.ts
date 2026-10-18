import {
    BookUser,
    CalendarPlus,
    Download,
    Eye,
    FileText,
    FolderDown,
    MailPlus,
    Presentation,
    Sheet,
} from 'lucide-react';
import { ICS_MAX_BYTES } from '../constants/calendar';
import { VCARD_MAX_BYTES } from '../constants/contact';
import { EML_MAX_BYTES } from '../constants/mail';
import { type ConvertTarget, isConvertSource, isEmlFile, isFolderType, isIcsFile, isVCardFile } from '../types/drive';
import type { FileAction, FileActionId, FileSubject, SubjectInfo } from '../types/file-subject';
import { subjectInfo } from './file-subject';

// Extension only, as the convert route refuses on the name (import-document.ts). A convert writes the new document
// beside its source, so a read-only Drive subject offers nothing.
const convertsTo =
    (target: ConvertTarget) =>
    (info: SubjectInfo, subject: FileSubject): boolean =>
        !!info.downloadUrl && isConvertSource(info.name, target) && !subject.readOnly;

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
    { id: 'convert-to-sheet', label: 'Convert to Sheet', icon: Sheet, applies: convertsTo('eigensheets') },
    { id: 'convert-to-document', label: 'Convert to Document', icon: FileText, applies: convertsTo('eigendoc') },
    { id: 'convert-to-slides', label: 'Convert to Slides', icon: Presentation, applies: convertsTo('eigenslides') },
    {
        id: 'import-contacts',
        label: 'Import to Contacts',
        icon: BookUser,
        // Over the ceiling the import 413s, so offer nothing.
        applies: (info) => !!info.downloadUrl && isVCardFile(info.mimeType, info.name) && info.size <= VCARD_MAX_BYTES,
        guestDenied: true,
    },
    {
        id: 'import-mail',
        label: 'Import to Mail',
        icon: MailPlus,
        applies: (info) => !!info.downloadUrl && isEmlFile(info.mimeType, info.name) && info.size <= EML_MAX_BYTES,
        guestDenied: true,
        mailOnly: true,
    },
    {
        id: 'import-calendar',
        label: 'Import to Calendar',
        icon: CalendarPlus,
        applies: (info) => !!info.downloadUrl && isIcsFile(info.mimeType, info.name) && info.size <= ICS_MAX_BYTES,
        guestDenied: true,
    },
];

export function fileActionsFor(subject: FileSubject, exclude?: readonly FileActionId[]): FileAction[] {
    const info = subjectInfo(subject);
    return FILE_ACTIONS.filter((action) => !exclude?.includes(action.id) && action.applies(info, subject));
}
