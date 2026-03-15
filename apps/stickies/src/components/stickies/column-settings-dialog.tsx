import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import * as Y from 'yjs';

type ColumnSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    columnId: string | null;
    columnTitle: string;
    yjsDoc: Y.Doc | null;
}

export function ColumnSettingsDialog({isOpen, onClose, columnId, columnTitle, yjsDoc}: ColumnSettingsDialogProps) {
    const [title, setTitle] = useState(columnTitle);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !yjsDoc || !columnId) return;

        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap('columns');
            const columnMap = columnsMap.get(columnId) as Y.Map<any>;
            if (columnMap) columnMap.set('title', title.trim());
        });

        onClose();
    };

    const handleDelete = () => {
        if (!yjsDoc || !columnId) return;

        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap('columns');
            const tasksMap = yjsDoc.getMap('tasks');
            const columnOrderArray = yjsDoc.getArray('columnOrder');

            const columnMap = columnsMap.get(columnId) as Y.Map<any>;
            if (!columnMap) return;

            const taskIdsArray = columnMap.get('taskIds') as Y.Array<any>;
            if (taskIdsArray) {
                for (const taskId of taskIdsArray.toArray() as string[]) {
                    tasksMap.delete(taskId);
                }
            }

            const columnOrder = columnOrderArray.toArray() as string[];
            const columnIndex = columnOrder.indexOf(columnId);
            if (columnIndex !== -1) columnOrderArray.delete(columnIndex, 1);

            columnsMap.delete(columnId);
        });

        setIsDeleteDialogOpen(false);
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
                            <Input
                                id="title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
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

            <DeleteDialog
                open={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                title="Delete Column"
                description="This will permanently delete the column and all cards within it. This action cannot be undone."
                onDelete={handleDelete}
            />
        </Dialog>
    );
}
