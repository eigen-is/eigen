import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { Textarea } from '@workspace/ui/components/textarea';
import { useState } from 'react';

type CardSettingsDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    color?: string | null;
    onSave: (patch: { title?: string; description?: string; color?: string | null }) => void;
};

type ContentProps = {
    initialTitle: string;
    initialDescription: string;
    initialColor: string | null | undefined;
    onOpenChange: (open: boolean) => void;
    onSave: (patch: { title?: string; description?: string; color?: string | null }) => void;
};

function CardSettingsDialogContent({
    initialTitle,
    initialDescription,
    initialColor,
    onOpenChange,
    onSave,
}: ContentProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState<string | null | undefined>(initialColor);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const patch: { title?: string; description?: string; color?: string | null } = {};
        if (title !== initialTitle) patch.title = title;
        if (description !== initialDescription) patch.description = description;
        if (color !== initialColor) patch.color = color ?? null;
        if (Object.keys(patch).length > 0) onSave(patch);
        onOpenChange(false);
    };

    return (
        <form onSubmit={handleSubmit}>
            <DialogHeader>
                <DialogTitle>Edit card</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label htmlFor="settings-title">Title</Label>
                    <Input id="settings-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="settings-description">Description</Label>
                    <Textarea
                        id="settings-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={6}
                    />
                </div>
                <div className="grid gap-2">
                    <Label>Color</Label>
                    <ColorPicker
                        value={color ?? ''}
                        onChange={(v) => setColor(v)}
                        colors={EIGEN_STICKIES_COLORS}
                        columns={8}
                    />
                </div>
            </div>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                </Button>
                <Button type="submit">Save</Button>
            </DialogFooter>
        </form>
    );
}

export function CardSettingsDialog({ open, onOpenChange, title, description, color, onSave }: CardSettingsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                {open && (
                    <CardSettingsDialogContent
                        initialTitle={title}
                        initialDescription={description}
                        initialColor={color}
                        onOpenChange={onOpenChange}
                        onSave={onSave}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
