import { getDriveItemUrl } from '@workspace/lib/api';
import { useCreateDriveItem } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DriveLocationPicker } from './drive-location-picker';

type EigenDocType = 'doc' | 'stickies' | 'slides' | 'sheets' | 'chat';

const LABELS: Record<EigenDocType, { title: string; nameLabel: string }> = {
    doc: { title: 'New document', nameLabel: 'Document name' },
    stickies: { title: 'New stickies', nameLabel: 'Stickies name' },
    slides: { title: 'New slides', nameLabel: 'Slides name' },
    sheets: { title: 'New sheet', nameLabel: 'Sheet name' },
    chat: { title: 'New chat', nameLabel: 'Chat name' },
};

type DriveCreateEigenDocProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    type: EigenDocType;
    defaultFolderId?: string;
    defaultMountId?: string;
    onAfterCreate?: (path: DrivePath) => void;
};

export function DriveCreateEigenDoc({
    open,
    onOpenChange,
    type,
    defaultFolderId,
    defaultMountId,
    onAfterCreate,
}: DriveCreateEigenDocProps) {
    const createMutation = useCreateDriveItem(type);
    const labels = LABELS[type];

    const handleConfirm = async (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => {
        if (!location.name?.trim()) return;
        const newPath = await createMutation.mutateAsync({
            ownerId: location.ownerId,
            mountId: location.mountId,
            parentId: location.folderId,
            fileName: location.name.trim(),
        });
        onOpenChange(false);
        const url = getDriveItemUrl(newPath);
        if (url) window.open(url, '_blank');
        onAfterCreate?.(newPath);
    };

    return (
        <DriveLocationPicker
            open={open}
            onOpenChange={onOpenChange}
            mode="create"
            onConfirm={handleConfirm}
            title={labels.title}
            nameLabel={labels.nameLabel}
            confirmLabel="Create"
            defaultMountId={defaultMountId}
            defaultFolderId={defaultFolderId}
        />
    );
}
