import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Label} from '@workspace/ui/components/label';
import {Textarea} from '@workspace/ui/components/textarea';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import * as Y from 'yjs';
import {EIGEN_STICKIES_COLORS} from "@workspace/lib/constants";

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
                <DialogContent size="sm">
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
                                <ColorPicker value={color} onChange={setColor} colors={EIGEN_STICKIES_COLORS}
                                             columns={8}/>
                            </div>
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="destructive"
                                className="mr-auto"
                                onClick={() => setIsDeleteDialogOpen(true)}
                            >
                                Delete Card
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
            </Dialog>

            <DeleteDialog
                open={isDeleteDialogOpen}
                onOpenChange={setIsDeleteDialogOpen}
                title="Delete Card"
                description="This will permanently delete the card. This action cannot be undone."
                onDelete={handleDelete}
            />
        </>
    );
}
