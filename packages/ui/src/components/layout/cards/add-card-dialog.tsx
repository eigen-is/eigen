import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { EditorShell, LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { useState } from 'react';

type AddCardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialTitle?: string;
    initialDescription?: string;
    initialColor?: string;
    onSave: (data: { title: string; description: string; color: string }) => void | Promise<void>;
    titleLabel?: string;
    placeholderTitle?: string;
    placeholderDescription?: string;
    submitLabel?: string;
};

type AddCardDialogContentProps = Required<Omit<AddCardDialogProps, 'open'>>;

function AddCardDialogContent({
    initialTitle,
    initialDescription,
    initialColor,
    onOpenChange,
    onSave,
    titleLabel,
    placeholderTitle,
    placeholderDescription,
    submitLabel,
}: AddCardDialogContentProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState(initialColor);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        setIsSubmitting(true);
        try {
            await onSave({ title: title.trim(), description, color });
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
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
                    <Label>Description</Label>
                    <EditorShell>
                        <LightEditor
                            content={initialDescription}
                            onChange={setDescription}
                            taskList
                            placeholder={placeholderDescription}
                            containerClassName="relative flex flex-col"
                            className="min-h-[80px]"
                        />
                    </EditorShell>
                </div>
                <div className="grid gap-2">
                    <Label>Color</Label>
                    <ColorPicker
                        value={color}
                        onChange={setColor}
                        colors={EIGEN_STICKIES_COLORS}
                        columns={8}
                        showReset={false}
                    />
                </div>
            </div>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!title.trim() || isSubmitting}>
                    {isSubmitting ? 'Saving…' : submitLabel}
                </Button>
            </DialogFooter>
        </form>
    );
}

export function AddCardDialog({
    open,
    onOpenChange,
    initialTitle = '',
    initialDescription = '',
    initialColor = EIGEN_STICKIES_COLORS[0][1].value,
    onSave,
    titleLabel = 'New card',
    placeholderTitle = 'Enter title',
    placeholderDescription = 'Enter description',
    submitLabel = 'Save',
}: AddCardDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                {open && (
                    <AddCardDialogContent
                        initialTitle={initialTitle}
                        initialDescription={initialDescription}
                        initialColor={initialColor}
                        onOpenChange={onOpenChange}
                        onSave={onSave}
                        titleLabel={titleLabel}
                        placeholderTitle={placeholderTitle}
                        placeholderDescription={placeholderDescription}
                        submitLabel={submitLabel}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
