import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Textarea} from '@workspace/ui/components/textarea';
import {Label} from '@workspace/ui/components/label';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {CardItem, STICKY_COLORS} from './types';
import {useAuth} from '@workspace/lib/auth';

type AddCardDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    onAddCard: (card: Omit<CardItem, 'id' | 'createdAt' | 'chatId'>) => void | Promise<void>;
    columnId: string | null;
}

export function AddCardDialog({isOpen, onClose, onAddCard, columnId}: AddCardDialogProps) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [color, setColor] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const {user} = useAuth();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !columnId) return;
        setIsSubmitting(true);

        try {
            await onAddCard({
                title: title.trim(),
                description: description.trim(),
                color: color || undefined,
                creator: user?.email || '',
            });
        } finally {
            setIsSubmitting(false);
        }

        setTitle('');
        setDescription('');
        setColor('');
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add Sticky</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="title">Title</Label>
                            <Input
                                id="title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Enter title"
                                autoFocus
                                required
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="description">Description</Label>
                            <Textarea
                                id="description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Enter description"
                                rows={3}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>Color</Label>
                            <ColorPicker value={color} onChange={setColor} colors={STICKY_COLORS} columns={8}/>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!title.trim() || isSubmitting}>
                            {isSubmitting ? 'Adding...' : 'Add Sticky'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
