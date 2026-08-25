import { getDriveItemUrl } from '@workspace/lib/api';
import { useCreateDriveItem } from '@workspace/lib/drive';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { DriveLocationPicker } from './drive-location-picker';

const LABELS: Record<EigenDocType, { title: string; nameLabel: string }> = {
    doc: { title: 'New doc', nameLabel: 'Doc name' },
    stickies: { title: 'New stickies', nameLabel: 'Stickies name' },
    slides: { title: 'New slide', nameLabel: 'Slide name' },
    sheets: { title: 'New sheet', nameLabel: 'Sheet name' },
    chat: { title: 'New chat', nameLabel: 'Chat name' },
    vector: { title: 'New vector', nameLabel: 'Vector name' },
};

type DriveCreateEigenDocProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    type: EigenDocType;
    defaultOwnerId?: string;
    defaultFolderId?: string;
    defaultMountId?: string;
    openInNewTab?: boolean;
    onAfterCreate?: (path: DrivePath) => void;
};

export function DriveCreateEigenDoc({
    open,
    onOpenChange,
    type,
    defaultOwnerId,
    defaultFolderId,
    defaultMountId,
    openInNewTab = true,
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
        if (openInNewTab) {
            const url = getDriveItemUrl(newPath);
            if (url) window.open(url, '_blank');
        }
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
            defaultOwnerId={defaultOwnerId}
            defaultMountId={defaultMountId}
            defaultFolderId={defaultFolderId}
        />
    );
}
