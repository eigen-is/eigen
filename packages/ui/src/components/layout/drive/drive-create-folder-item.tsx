import {useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {Button} from "@workspace/ui/components/button";
import {useBreadcrumb} from "@workspace/lib/drive";
import {DrivePath} from "@apps/api-server/types/drive";

interface DriveCreateItemDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreateItem: (itemName: string) => void;
    isPending?: boolean;
    type: string;
    path: DrivePath;
}

export function DriveCreateItemDialog({
                                          open,
                                          onOpenChange,
                                          onCreateItem,
                                          isPending = false,
                                          type,
                                          path
                                      }: DriveCreateItemDialogProps) {
    const [itemName, setItemName] = useState("");
    const {data: breadcrumbPaths = []} = useBreadcrumb(path.ownerId, path.id);

    const handleCreateItem = () => {
        if (itemName.trim() && !isPending) {
            onCreateItem(itemName);
            setItemName("");
        }
    };

    const handleCancel = () => {
        onOpenChange(false);
        setItemName("");
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New {type.toLowerCase()}</DialogTitle>
                </DialogHeader>
                <div className="py-4">
                    <Label htmlFor="itemName" className="mb-3">{type} name</Label>
                    <Input
                        id="itemName"
                        value={itemName}
                        onChange={(e) => setItemName(e.target.value)}
                        placeholder={`Enter ${type.toLowerCase()} name`}
                        className="mt-2"
                        autoFocus
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && itemName.trim() && !isPending) {
                                e.preventDefault();
                                handleCreateItem();
                            }
                        }}
                    />
                    <div className="mt-4 mb-4">
                        <Label className="mb-1">Location</Label>
                        <span className="text-sm text-muted-foreground truncate block">
                           {breadcrumbPaths.map((path) =>
                               path.name || "Drive"
                           ).join(' > ')}
                        </span>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={handleCancel}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleCreateItem}
                        disabled={!itemName.trim() || isPending}
                    >
                        {isPending ? "Creating..." : "Create"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
