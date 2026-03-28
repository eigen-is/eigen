import {getChatRoomUrl} from '@workspace/lib/api';
import {useCreateChat} from '@workspace/lib/chat';
import type {DrivePath} from '@workspace/lib/types/drive';
import {DriveCreateItemDialog} from './drive-create-folder-item';

export type DriveCreateChatProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveCreateChat({path, open, onOpenChange, onSave, onCancel, onAfterAction}: DriveCreateChatProps) {
    const createChatMutation = useCreateChat(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateChat = async (fileName: string) => {
        const newPath = await createChatMutation.mutateAsync({
            parentId: path.id,
            fileName: fileName,
        });
        onOpenChange(false);

        if (onAfterAction) {
            onAfterAction('create', {name: fileName});
        }

        if (newPath) {
            const url = getChatRoomUrl(path.ownerId, path.mountId, newPath.id);
            window.open(url, '_blank');
        }

        if (onSave) onSave(newPath?.id || '');
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateChat}
            isPending={createChatMutation.isPending}
            type="Chat"
            path={path}
        />
    );
}
