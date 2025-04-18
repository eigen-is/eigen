import { toast } from "sonner";
import { DrivePath } from "@apps/api-server/types/drive";
import { useCreateFolder, useInvalidateFolder } from "@workspace/lib/drive";
import { DriveCreateItemDialog } from "./drive-create-folder-item";

export interface DriveCreateFolderProps {
  path: DrivePath;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (newPath: string) => void;
  onCancel?: () => void;
  onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveCreateFolder({
  path,
  open,
  onOpenChange,
  onSave,
  onCancel,
  onAfterAction,
}: DriveCreateFolderProps) {
  const createFolderMutation = useCreateFolder(path.ownerId);
  const invalidateFolder = useInvalidateFolder();

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen && onCancel) onCancel();
  };

  const handleCreateFolder = async (folderName: string) => {
    try {
      const newPath = await createFolderMutation.mutateAsync({
        parentId: path.id,
        folderName: folderName,
      });
      toast.success(`Folder "${folderName}" created successfully`);
      onOpenChange(false);
      
      // Invalidate folder to refresh the folder contents
      invalidateFolder(path.id);
      
      // Call onAfterAction if provided
      if (onAfterAction) {
        onAfterAction('create', {name: folderName});
      }
      
      if (onSave) onSave(newPath || '');
    } catch (error: any) {
      toast.error(error?.message || "Failed to create folder");
    }
  };

  return (
    <DriveCreateItemDialog
      open={open}
      onOpenChange={handleOpenChange}
      onCreateItem={handleCreateFolder}
      isPending={createFolderMutation.isPending}
      type="Folder"
    />
  );
}
