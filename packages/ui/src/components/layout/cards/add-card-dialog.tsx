import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { Textarea } from '@workspace/ui/components/textarea';
import { useEffect, useState } from 'react';

type AddCardDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    initialTitle?: string;
    initialDescription?: string;
    initialColor?: string;
    onSave: (data: { title: string; description: string; color?: string }) => void | Promise<void>;
    titleLabel?: string;
    placeholderTitle?: string;
    placeholderDescription?: string;
    submitLabel?: string;
};

export function AddCardDialog({
    isOpen,
    onClose,
    initialTitle = '',
    initialDescription = '',
    initialColor = EIGEN_STICKIES_COLORS[0][1].value,
    onSave,
    titleLabel = 'New card',
    placeholderTitle = 'Enter title',
    placeholderDescription = 'Enter description',
    submitLabel = 'Save',
}: AddCardDialogProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState(initialColor);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setTitle(initialTitle);
            setDescription(initialDescription);
            setColor(initialColor);
        }
    }, [isOpen, initialTitle, initialDescription, initialColor]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        setIsSubmitting(true);
        try {
            await onSave({ title: title.trim(), description: description.trim(), color: color || undefined });
            onClose();
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
            <DialogContent size="sm">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>{titleLabel}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="card-title">Title</Label>
                            <Input
                                id="card-title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder={placeholderTitle}
                                autoFocus
                                required
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="card-description">Description</Label>
                            <Textarea
                                id="card-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder={placeholderDescription}
                                rows={3}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>Color</Label>
                            <ColorPicker value={color} onChange={setColor} colors={EIGEN_STICKIES_COLORS} columns={8} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!title.trim() || isSubmitting}>
                            {isSubmitting ? 'Saving…' : submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
