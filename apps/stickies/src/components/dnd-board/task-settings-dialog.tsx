import {useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {Textarea} from "@workspace/ui/components/textarea";
import * as Y from "yjs";

interface TaskSettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    taskId: string | null;
    taskTitle: string;
    taskDescription: string;
    yjsDoc: Y.Doc | null;
}

export function TaskSettingsDialog({
                                       isOpen,
                                       onClose,
                                       taskId,
                                       taskTitle,
                                       taskDescription,
                                       yjsDoc,
                                   }: TaskSettingsDialogProps) {
    const [title, setTitle] = useState(taskTitle);
    const [description, setDescription] = useState(taskDescription);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !yjsDoc || !taskId) return;

        yjsDoc.transact(() => {
            const tasksMap = yjsDoc.getMap("tasks");
            const taskMap = tasksMap.get(taskId) as Y.Map<any>;
            if (taskMap) {
                taskMap.set("title", title.trim());
                taskMap.set("description", description.trim());
            }
        });

        onClose();
    };

    const handleDelete = () => {
        if (!yjsDoc || !taskId) return;

        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap("columns");
            const tasksMap = yjsDoc.getMap("tasks");

            let foundColumn: Y.Map<any> | null = null;
            let taskIndex = -1;

            for (const [, columnMapValue] of columnsMap) {
                if (!(columnMapValue instanceof Y.Map)) return;
                const columnMap = columnMapValue;
                const taskIdsArray = columnMap.get("taskIds") as Y.Array<any>;
                const taskIds = taskIdsArray.toArray() as string[];

                const index = taskIds.indexOf(taskId);
                if (index !== -1) {
                    foundColumn = columnMap;
                    taskIndex = index;
                }
            }

            if (foundColumn && taskIndex !== -1) {
                const taskIdsArray = (foundColumn as Y.Map<any>).get("taskIds") as Y.Array<any>;
                taskIdsArray.delete(taskIndex, 1);
            }

            tasksMap.delete(taskId);
        });

        setIsDeleteDialogOpen(false);
        onClose();
    };

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Task Settings</DialogTitle>
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
                            <div className="grid gap-2">
                                <Label htmlFor="description">Description</Label>
                                <Textarea
                                    id="description"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    className="min-h-[100px]"
                                />
                            </div>
                        </div>
                        <DialogFooter className="sm:justify-between">
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => setIsDeleteDialogOpen(true)}
                            >
                                Delete Task
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
            </Dialog>

            <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete Task</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-gray-500">
                            This will permanently delete the task.
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
        </>
    );
}
