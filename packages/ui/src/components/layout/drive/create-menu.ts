import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import { EIGEN_DOC_TYPE_INFO, type EigenDocType } from '@workspace/lib/types/drive';
import { FolderPlus, type LucideIcon, UploadIcon } from 'lucide-react';

export type CreateCallbacks = {
    onCreateFolder?: () => void;
    onCreateEigenDoc?: Partial<Record<EigenDocType, () => void>>;
    onUploadFile?: () => void;
};

type CreateMenuKind = 'folder' | 'upload' | EigenDocType;
type CreateMenuDef = { kind: CreateMenuKind; icon: LucideIcon; label: string; buttonLabel: string };

// Derive each eigendoc entry from the shared registries so adding a doc type is a
// single-source edit (EIGEN_DOC_TYPE_INFO + EIGEN_DOC_ICONS), not a copy here.
const CREATE_MENU_DEFS: CreateMenuDef[] = [
    { kind: 'folder', icon: FolderPlus, label: 'New folder', buttonLabel: 'New folder' },
    ...Object.values(EIGEN_DOC_TYPE_INFO).map((info): CreateMenuDef => {
        const label = `New ${info.label.toLowerCase()}`;
        return { kind: info.type, icon: EIGEN_DOC_ICONS[info.type], label, buttonLabel: label };
    }),
    { kind: 'upload', icon: UploadIcon, label: 'Upload file', buttonLabel: 'Upload' },
];

export function getCreateMenuItems(cb: CreateCallbacks) {
    return CREATE_MENU_DEFS.flatMap((def) => {
        const onSelect =
            def.kind === 'folder'
                ? cb.onCreateFolder
                : def.kind === 'upload'
                  ? cb.onUploadFile
                  : cb.onCreateEigenDoc?.[def.kind];
        return onSelect ? [{ ...def, onSelect }] : [];
    });
}
