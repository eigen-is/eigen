import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Button } from "@workspace/ui/components/button";

export interface DeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  itemName?: string;
  onDelete: () => void;
  cancelText?: string;
  deleteText?: string;
}

export function DeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  itemName,
  onDelete,
  cancelText = "Cancel",
  deleteText = "Delete"
}: DeleteDialogProps) {
  // Format description with item name if provided
  const formattedDescription = itemName 
    ? `${description} ${itemName}? This action cannot be undone.`
    : `${description}? This action cannot be undone.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {formattedDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelText}
          </Button>
          <Button variant="destructive" onClick={onDelete}>
            {deleteText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
