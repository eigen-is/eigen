import {toast} from "sonner";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useCreateChat} from "@workspace/lib/chat";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export type DriveCreateChatProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateChat({
                                    path,
                                    open,
                                    onOpenChange,
                                    onSave,
                                    onCancel,
                                    onAfterAction,
                                }: DriveCreateChatProps) {
    const createChatMutation = useCreateChat(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateChat = async (fileName: string) => {
        try {
            const newPath = await createChatMutation.mutateAsync({
                parentId: path.id,
                fileName: fileName,
            });
            onOpenChange(false);

            if (onAfterAction) {
                onAfterAction('create', {name: fileName});
            }

            if (newPath) {
                const url = `${import.meta.env.VITE_APP_CHAT_URL}/${path.ownerId}/${path.mountId}/${newPath.id}`;
                window.open(url, '_blank');
            }

            if (onSave) onSave(newPath?.id || '');
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to create chat");
        }
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
