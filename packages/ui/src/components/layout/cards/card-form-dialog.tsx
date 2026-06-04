import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { useRef, useState } from 'react';

type CardFormDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // 'edit' emits a minimal diff (only changed fields), so an unchanged save is a
    // no-op Yjs update. 'create' always emits a concrete color + trimmed title so a
    // brand-new card never persists an empty title or a missing (uncolored) color.
    mode?: 'create' | 'edit';
    initialTitle?: string;
    initialDescription?: string;
    initialColor?: string;
    onSave: (patch: { title?: string; description?: string; color?: string }) => void | Promise<void>;
    dialogTitle?: string;
    placeholderTitle?: string;
    placeholderDescription?: string;
    submitLabel?: string;
};

type CardFormDialogContentProps = Required<Omit<CardFormDialogProps, 'open'>>;

function CardFormDialogContent({
    mode,
    initialTitle,
    initialDescription,
    initialColor,
    onOpenChange,
    onSave,
    dialogTitle,
    placeholderTitle,
    placeholderDescription,
    submitLabel,
}: CardFormDialogContentProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState(initialColor);
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Capture the canonical TipTap-emitted form of the seeded description on
    // first mount. Old plain-text descriptions get wrapped in <p>...</p> by
    // TipTap; without this, a "Save" with no edits would write the
    // canonicalised HTML back, marking the card dirty for no reason. Mirrors
    // the mail compose pattern (apps/mail/.../use-draft.ts).
    const canonicalInitialDescription = useRef(initialDescription);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        const patch: { title?: string; description?: string; color?: string } = {};
        if (mode === 'create') {
            // A new card must carry concrete values: a trimmed title and the
            // seeded color (which the user may never touch). The diff below would
            // drop an untouched color, leaving the card uncolored.
            patch.title = title.trim();
            patch.description = description;
            patch.color = color;
        } else {
            if (title !== initialTitle) patch.title = title;
            if (description !== canonicalInitialDescription.current) patch.description = description;
            if (color !== initialColor) patch.color = color;
        }
        setIsSubmitting(true);
        try {
            await onSave(patch);
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <DialogHeader>
                <DialogTitle>{dialogTitle}</DialogTitle>
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
                    <div className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-within:ring-[3px] focus-within:ring-ring/50">
                        <LightEditor
                            content={initialDescription}
                            onChange={setDescription}
                            onReady={({ html }) => {
                                canonicalInitialDescription.current = html;
                                setDescription(html);
                            }}
                            taskList
                            placeholder={placeholderDescription}
                            containerClassName="relative flex flex-col"
                            className="min-h-[200px]"
                        />
                    </div>
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
                    {isSubmitting ? 'Saving...' : submitLabel}
                </Button>
            </DialogFooter>
        </form>
    );
}

export function CardFormDialog({
    open,
    onOpenChange,
    mode = 'create',
    initialTitle = '',
    initialDescription = '',
    initialColor = EIGEN_STICKIES_COLORS[0][1].value,
    onSave,
    dialogTitle = 'New card',
    placeholderTitle = 'Enter title',
    placeholderDescription = 'Enter description',
    submitLabel = 'Save',
}: CardFormDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md">
                {open && (
                    <CardFormDialogContent
                        mode={mode}
                        initialTitle={initialTitle}
                        initialDescription={initialDescription}
                        initialColor={initialColor}
                        onOpenChange={onOpenChange}
                        onSave={onSave}
                        dialogTitle={dialogTitle}
                        placeholderTitle={placeholderTitle}
                        placeholderDescription={placeholderDescription}
                        submitLabel={submitLabel}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
