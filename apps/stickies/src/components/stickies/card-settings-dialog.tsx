import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {Textarea} from '@workspace/ui/components/textarea';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {STICKY_COLORS} from './types';
import * as Y from 'yjs';

type CardSettingsDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    cardId: string | null;
    cardTitle: string;
    cardDescription: string;
    cardColor: string;
    yjsDoc: Y.Doc | null;
}

export function CardSettingsDialog({isOpen, onClose, cardId, cardTitle, cardDescription, cardColor, yjsDoc}: CardSettingsDialogProps) {
    const [title, setTitle] = useState(cardTitle);
    const [description, setDescription] = useState(cardDescription);
    const [color, setColor] = useState(cardColor);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !yjsDoc || !cardId) return;

        yjsDoc.transact(() => {
            const tasksMap = yjsDoc.getMap('tasks');
            const taskMap = tasksMap.get(cardId) as Y.Map<any>;
            if (taskMap) {
                taskMap.set('title', title.trim());
                taskMap.set('description', description.trim());
                taskMap.set('color', color);
            }
        });

        onClose();
    };

    const handleDelete = () => {
        if (!yjsDoc || !cardId) return;

        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap('columns');
            const tasksMap = yjsDoc.getMap('tasks');

            for (const [, columnMapValue] of columnsMap) {
                if (!(columnMapValue instanceof Y.Map)) return;
                const taskIdsArray = columnMapValue.get('taskIds') as Y.Array<any>;
                const taskIds = taskIdsArray.toArray() as string[];
                const index = taskIds.indexOf(cardId);
                if (index !== -1) {
                    taskIdsArray.delete(index, 1);
                    break;
                }
            }

            tasksMap.delete(cardId);
        });

        setIsDeleteDialogOpen(false);
        onClose();
    };

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Card Settings</DialogTitle>
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
                            <div className="grid gap-2">
                                <Label htmlFor="description">Description</Label>
                                <Textarea
                                    id="description"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    className="min-h-[100px]"
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>Color</Label>
                                <ColorPicker value={color} onChange={setColor} colors={STICKY_COLORS} columns={8}/>
                            </div>
                        </div>
                        <DialogFooter className="sm:justify-between">
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => setIsDeleteDialogOpen(true)}
                            >
                                Delete Card
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
                        <DialogTitle>Delete Card</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-gray-500">
                            This will permanently delete the card.
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
