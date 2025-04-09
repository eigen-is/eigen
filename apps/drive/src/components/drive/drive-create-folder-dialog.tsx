import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Button } from "@workspace/ui/components/button";

interface DriveCreateFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateFolder: (folderName: string) => void;
  isPending?: boolean;
}

export function DriveCreateFolderDialog({
  open,
  onOpenChange,
  onCreateFolder,
  isPending = false,
}: DriveCreateFolderDialogProps) {
  const [folderName, setFolderName] = useState("");

  const handleCreateFolder = () => {
    if (folderName.trim() && !isPending) {
      onCreateFolder(folderName);
      setFolderName("");
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
    setFolderName("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Folder</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Label htmlFor="folderName">Folder Name</Label>
          <Input
            id="folderName"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="Enter folder name"
            className="mt-2"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && folderName.trim() && !isPending) {
                e.preventDefault();
                handleCreateFolder();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleCreateFolder}
            disabled={!folderName.trim() || isPending}
          >
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
