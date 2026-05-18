import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { EditorShell, LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { useRef, useState } from 'react';

type CardSettingsDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    color: string;
    onSave: (patch: { title?: string; description?: string; color?: string }) => void;
    dialogTitle?: string;
};

type CardSettingsDialogContentProps = Required<Omit<CardSettingsDialogProps, 'open'>>;

function CardSettingsDialogContent({
    title: initialTitle,
    description: initialDescription,
    color: initialColor,
    onOpenChange,
    onSave,
    dialogTitle,
}: CardSettingsDialogContentProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState(initialColor);
    // Capture the canonical TipTap-emitted form of the seeded description on
    // first mount. Old plain-text descriptions get wrapped in <p>...</p> by
    // TipTap; without this, a "Save" with no edits would write the
    // canonicalised HTML back, marking the card dirty for no reason. Mirrors
    // the mail compose pattern (apps/mail/.../use-draft.ts).
    const canonicalInitialDescription = useRef(initialDescription);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        const patch: { title?: string; description?: string; color?: string } = {};
        if (title !== initialTitle) patch.title = title;
        if (description !== canonicalInitialDescription.current) patch.description = description;
        if (color !== initialColor) patch.color = color;
        if (Object.keys(patch).length > 0) onSave(patch);
        onOpenChange(false);
    };

    return (
        <form onSubmit={handleSubmit}>
            <DialogHeader>
                <DialogTitle>{dialogTitle}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                    <Label htmlFor="settings-title">Title</Label>
                    <Input id="settings-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                </div>
                <div className="grid gap-2">
                    <Label>Description</Label>
                    <EditorShell>
                        <LightEditor
                            content={initialDescription}
                            onChange={setDescription}
                            onReady={({ html }) => {
                                canonicalInitialDescription.current = html;
                                setDescription(html);
                            }}
                            taskList
                            containerClassName="relative flex flex-col"
                            className="min-h-[120px]"
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
                <Button type="submit" disabled={!title.trim()}>
                    Save
                </Button>
            </DialogFooter>
        </form>
    );
}

export function CardSettingsDialog({
    open,
    onOpenChange,
    title,
    description,
    color,
    onSave,
    dialogTitle = 'Edit card',
}: CardSettingsDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm">
                {open && (
                    <CardSettingsDialogContent
                        title={title}
                        description={description}
                        color={color}
                        onOpenChange={onOpenChange}
                        onSave={onSave}
                        dialogTitle={dialogTitle}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
