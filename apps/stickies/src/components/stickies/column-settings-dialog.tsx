import { getIdArray, getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab';
import { DeleteDialog } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useState } from 'react';
import type * as Y from 'yjs';

type ColumnSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    columnId: string;
    columnTitle: string;
    cardCount?: number;
    yjsDoc: Y.Doc | null;
    // Seals the column delete as its own undo step (U6e).
    undoManager: Y.UndoManager | null;
};

export function ColumnSettingsDialog({
    isOpen,
    onClose,
    columnId,
    columnTitle,
    cardCount = 0,
    yjsDoc,
    undoManager,
}: ColumnSettingsDialogProps) {
    const [title, setTitle] = useState(columnTitle);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !yjsDoc) return;

        yjsDoc.transact(() => {
            const columnMap = getItemMapRoot(yjsDoc, 'columns').get(columnId);
            if (columnMap) columnMap.set('title', title.trim());
        });

        onClose();
    };

    const handleDelete = () => {
        if (!yjsDoc) return;

        undoManager?.stopCapturing();
        yjsDoc.transact(() => {
            const columnsMap = getItemMapRoot(yjsDoc, 'columns');
            const tasksMap = yjsDoc.getMap('tasks');
            const columnOrderArray = getIdArrayRoot(yjsDoc, 'columnOrder');

            const columnMap = columnsMap.get(columnId);
            if (!columnMap) return;

            const taskIdsArray = getIdArray(columnMap, 'taskIds');
            if (taskIdsArray) {
                for (const taskId of taskIdsArray.toArray()) {
                    tasksMap.delete(taskId);
                }
            }

            const columnOrder = columnOrderArray.toArray();
            const columnIndex = columnOrder.indexOf(columnId);
            if (columnIndex !== -1) columnOrderArray.delete(columnIndex, 1);

            columnsMap.delete(columnId);
        });
        undoManager?.stopCapturing();

        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Column Settings</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit}>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="title">Title</Label>
                            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="destructive"
                            className="mr-auto"
                            onClick={() => setIsDeleteDialogOpen(true)}
                        >
                            Delete Column
                        </Button>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!title.trim()}>
                            Save Changes
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>

            <DeleteDialog
                open={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                title="Delete Column"
                description={
                    cardCount > 0
                        ? `This will permanently delete the column and ${cardCount} ${cardCount === 1 ? 'card' : 'cards'} within it. This action cannot be undone.`
                        : 'This will permanently delete the column. This action cannot be undone.'
                }
                onDelete={handleDelete}
            />
        </Dialog>
    );
}
