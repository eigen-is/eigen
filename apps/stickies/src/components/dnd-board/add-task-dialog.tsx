import React, {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Textarea} from "@workspace/ui/components/textarea";
import {TaskItem} from './types';
import {useAuth} from "@workspace/lib/auth";

interface AddTaskDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onAddTask: (task: Omit<TaskItem, 'id' | 'comments'>) => void;
    columnId: string | null;
}

export const AddTaskDialog: React.FC<AddTaskDialogProps> = ({
                                                                isOpen,
                                                                onClose,
                                                                onAddTask,
                                                                columnId
                                                            }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const {user} = useAuth();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!title.trim() || !columnId) return;

        onAddTask({
            title: title.trim(),
            description: description.trim(),
            creator: user?.email || '',
            createdAt: Date.now()
        });

        setTitle('');
        setDescription('');
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add Task</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <label htmlFor="title" className="text-sm font-medium">
                                Title
                            </label>
                            <Input
                                id="title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Enter task title"
                                className="col-span-3"
                                autoFocus
                                required
                            />
                        </div>
                        <div className="grid gap-2">
                            <label htmlFor="description" className="text-sm font-medium">
                                Description
                            </label>
                            <Textarea
                                id="description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Enter task description"
                                className="col-span-3"
                                rows={3}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!title.trim()}>
                            Add Task
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
