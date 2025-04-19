import React, {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {ColumnItem} from './types';
import {useAuth} from "@workspace/lib/auth/auth-context.tsx";

interface AddColumnDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onAddColumn: (column: Omit<ColumnItem, 'id' | 'taskIds'>) => void;
}

export const AddColumnDialog: React.FC<AddColumnDialogProps> = ({
                                                                    isOpen,
                                                                    onClose,
                                                                    onAddColumn
                                                                }) => {
    const [title, setTitle] = useState('');
    const {user} = useAuth();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!title.trim()) return;

        onAddColumn({
            title: title.trim(),
            creator: user?.email || '',
            createdAt: Date.now()
        });

        setTitle('');
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add Column</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <label htmlFor="column-title" className="text-sm font-medium">
                                Title
                            </label>
                            <Input
                                id="column-title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Enter column title"
                                className="col-span-3"
                                autoFocus
                                required
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!title.trim()}>
                            Add Column
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
