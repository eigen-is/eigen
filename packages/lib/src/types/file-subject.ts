import type { LucideIcon } from 'lucide-react';
import type { DrivePath } from './drive';

// One file a surface can act on, whatever holds it. The URLs are built once, by the builders in
// core/file-subject.ts, so no consumer composes a route by hand.
export type FileSubject = {
    // Identity for sibling matching: drive:{ownerId}:{mountId}:{id} or mail:{ownerId}:{messageId}:{index}.
    key: string;
    name: string;
    mimeType: string;
    size: number;
    embedUrl: string;
    // Absent when there are no raw bytes to hand out: a folder, an Eigen container.
    downloadUrl?: string;
    thumbnailUrl?: string;
    // Present: Open, the Drive-side previews, and every Drive-side action.
    drive?: DrivePath;
    // Present on a mail part: what a write route needs to name it. Never parse the key for it.
    mail?: MailPartRef;
    // A message's or container's attachment, not a file at a Drive location: saved as a set, and
    // converted only after a save to a folder the user picks (a chat copy sits in a hidden media folder).
    attachment?: true;
};

// One part of one message, by the RAW part index the mail routes address.
export type MailPartRef = { ownerId: string; messageId: string; index: number };

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
    applies: (subject: FileSubject) => boolean;
};
