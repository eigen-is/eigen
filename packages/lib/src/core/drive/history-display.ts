import type { FileEventType } from '@workspace/lib/types/file-history';
import {
    Copy,
    FilePlus,
    FolderInput,
    History,
    type LucideIcon,
    MessageSquare,
    Pencil,
    Plus,
    RotateCcw,
    TextCursorInput,
    Trash2,
    Upload,
    UserRoundPlus,
    X,
} from 'lucide-react';

// Icon map for file event types. Kept in a values module (not types/) so the API
// server can remain type-only on file-history — same split as EIGEN_DOC_ICONS.
export const FILE_EVENT_ICONS: Record<FileEventType, LucideIcon> = {
    created: FilePlus,
    uploaded: Upload,
    edited: Pencil,
    renamed: TextCursorInput,
    moved: FolderInput,
    copied: Copy,
    'acl-changed': UserRoundPlus,
    trashed: Trash2,
    restored: RotateCcw,
    deleted: X,
    'version-restored': History,
    commented: MessageSquare,
    'sticky-added': Plus,
    'sticky-moved': FolderInput,
    'sticky-removed': Trash2,
    'slide-added': Plus,
    'slide-removed': Trash2,
    'slide-reordered': FolderInput,
};
