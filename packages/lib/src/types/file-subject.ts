import type { LucideIcon } from 'lucide-react';
import type { DrivePath } from './drive';
import type { Attachment } from './mail';

// One file a surface can act on, whatever holds it: its identity, and nothing that follows from it.
// Everything derivable — the key, the name, the mime, the size, the URLs — comes from `subjectInfo`
// in core/file-subject.ts, so no consumer composes a route by hand and no fact is stored twice.
export type FileSubject = (
    | { drive: DrivePath; mail?: undefined }
    // The part's own facts ride along: nothing is fetched to name a part or size it.
    | { drive?: undefined; mail: MailPartRef; part: Pick<Attachment, 'contentType' | 'filename' | 'size'> }
) & {
    // A message's or container's attachment, not a file at a Drive location: saved as a set, and
    // converted only after a save to a folder the user picks (a chat copy sits in a hidden media folder).
    attachment?: true;
};

// One part of one message, by the RAW part index the mail routes address.
export type MailPartRef = { ownerId: string; messageId: string; index: number };

// What a surface reads off a subject, derived once by `subjectInfo`.
export type SubjectInfo = {
    // Identity for sibling matching: drive:{ownerId}:{mountId}:{id} or mail:{ownerId}:{messageId}:{index}.
    key: string;
    name: string;
    mimeType: string;
    size: number;
    embedUrl: string;
    // Absent when there are no raw bytes to hand out: a folder, an Eigen container.
    downloadUrl?: string;
    thumbnailUrl?: string;
};

export type PreviewMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'vcard' | 'fallback';

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
    // Derived facts first: most rows decide on those alone and never look at what holds the file.
    applies: (info: SubjectInfo, subject: FileSubject) => boolean;
};
