import type {DrivePath} from "@workspace/lib/types/drive";
import {useCreateSlides} from "@workspace/lib/drive";
import {getSlideUrl} from "@workspace/lib/api";
import {DriveCreateItemDialog} from "./drive-create-folder-item";

export type DriveCreateSlidesProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave?: (newPath: string) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateSlides({
                                      path,
                                      open,
                                      onOpenChange,
                                      onSave,
                                      onCancel,
                                      onAfterAction,
                                  }: DriveCreateSlidesProps) {
    const createSlidesMutation = useCreateSlides(path.ownerId, path.mountId);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (!nextOpen && onCancel) onCancel();
    };

    const handleCreateSlides = async (fileName: string) => {
        const newPath = await createSlidesMutation.mutateAsync({
            parentId: path.id,
            fileName: fileName,
        });
        onOpenChange(false);

        if (onAfterAction) {
            onAfterAction('create', {name: fileName});
        }

        if (newPath) {
            const url = getSlideUrl(path.ownerId, path.mountId, newPath.id);
            window.open(url, '_blank');
        }

        if (onSave) onSave(newPath?.id || '');
    };

    return (
        <DriveCreateItemDialog
            open={open}
            onOpenChange={handleOpenChange}
            onCreateItem={handleCreateSlides}
            isPending={createSlidesMutation.isPending}
            type="Slides"
            path={path}
        />
    );
}
