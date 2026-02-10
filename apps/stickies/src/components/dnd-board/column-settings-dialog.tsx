import {useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import * as Y from "yjs";

interface ColumnSettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    columnId: string | null;
    columnTitle: string;
    yjsDoc: Y.Doc | null;
}

export function ColumnSettingsDialog({
                                         isOpen,
                                         onClose,
                                         columnId,
                                         columnTitle,
                                         yjsDoc,
                                     }: ColumnSettingsDialogProps) {
    const [title, setTitle] = useState(columnTitle);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !yjsDoc || !columnId) return;

        // Update column title in Yjs
        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap("columns");
            const columnMap = columnsMap.get(columnId) as Y.Map<any>;
            if (columnMap) {
                columnMap.set("title", title.trim());
            }
        });

        onClose();
    };

    const handleDelete = () => {
        if (!yjsDoc || !columnId) return;

        yjsDoc.transact(() => {
            // Get all maps
            const columnsMap = yjsDoc.getMap("columns");
            const tasksMap = yjsDoc.getMap("tasks");
            const columnOrderArray = yjsDoc.getArray("columnOrder");

            // Get the column and its tasks
            const columnMap = columnsMap.get(columnId) as Y.Map<any>;
            if (!columnMap) return;

            const taskIdsArray = columnMap.get("taskIds") as Y.Array<any>;
            if (!taskIdsArray) return;

            // Delete all tasks in this column
            const taskIds = taskIdsArray.toArray() as string[];
            for(const taskId of taskIds) {
                tasksMap.delete(taskId);
            }

            // Remove from column order
            const columnOrder = columnOrderArray.toArray() as string[];
            const columnIndex = columnOrder.indexOf(columnId);
            if (columnIndex !== -1) {
                columnOrderArray.delete(columnIndex, 1);
            }

            // Delete the column itself
            columnsMap.delete(columnId);
        });

        setIsDeleteDialogOpen(false);
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Column Settings</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit}>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="title">Title</Label>
                            <Input
                                id="title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="col-span-3"
                            />
                        </div>
                    </div>
                    <DialogFooter className="sm:justify-between">
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={() => setIsDeleteDialogOpen(true)}
                        >
                            Delete Column
                        </Button>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!title.trim()}>
                                Save Changes
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>

            {/* Confirmation dialog for column deletion */}
            <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete Column</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-gray-500">
                            This will permanently delete the column and all tasks within it.
                            This action cannot be undone.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Dialog>
    );
}
