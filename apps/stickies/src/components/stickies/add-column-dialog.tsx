import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {ColumnItem} from './types';
import {useAuth} from '@workspace/lib/auth';

type AddColumnDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    onAddColumn: (column: Omit<ColumnItem, 'id' | 'taskIds'>) => void;
}

export function AddColumnDialog({isOpen, onClose, onAddColumn}: AddColumnDialogProps) {
    const [title, setTitle] = useState('');
    const {user} = useAuth();

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;

        onAddColumn({
            title: title.trim(),
            creator: user?.email || '',
            createdAt: Date.now(),
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
                            <Label htmlFor="column-title">Title</Label>
                            <Input
                                id="column-title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Enter column title"
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
}
