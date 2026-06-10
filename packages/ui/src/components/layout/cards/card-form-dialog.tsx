import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { ColorPicker } from '@workspace/ui/components/layout/media/color-picker';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFileDropTarget } from '../../../hooks/use-file-drop-target';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';

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
    // Attachment staging is purely local — Files/DrivePaths are handed to onSave as
    // drafts; the host resolves them (upload/copy) at save time. Cancel touches nothing.
    allowAttachments?: boolean;
    initialAttachments?: ChatAttachment[];
    onSave: (
        patch: { title?: string; description?: string; color?: string },
        attachments?: CardAttachmentDraft[],
    ) => void | Promise<void>;
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
    allowAttachments,
    initialAttachments,
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
    const [drafts, setDrafts] = useState<CardAttachmentDraft[]>(initialAttachments);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Capture the canonical TipTap-emitted form of the seeded description on
    // first mount. Old plain-text descriptions get wrapped in <p>...</p> by
    // TipTap; without this, a "Save" with no edits would write the
    // canonicalised HTML back, marking the card dirty for no reason. Mirrors
    // the mail compose pattern (apps/mail/.../use-draft.ts).
    const canonicalInitialDescription = useRef(initialDescription);

    const stageFiles = (files: File[]) => setDrafts((prev) => [...prev, ...files]);
    const dropProps = useFileDropTarget(stageFiles, allowAttachments);

    const handlePaste = (e: React.ClipboardEvent) => {
        if (!allowAttachments) return;
        const pastedFiles = Array.from(e.clipboardData.files);
        if (pastedFiles.length === 0) return;
        e.preventDefault();
        stageFiles(pastedFiles);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        const patch: { title?: string; description?: string; color?: string } = {};
        // Edit mode seeds drafts with the existing ChatAttachment objects, so identity
        // compare detects any removal/addition without a deep equality pass.
        const draftsChanged =
            drafts.length !== initialAttachments.length || drafts.some((d, i) => d !== initialAttachments[i]);
        let attachments: CardAttachmentDraft[] | undefined;
        if (mode === 'create') {
            // A new card must carry concrete values: a trimmed title and the
            // seeded color (which the user may never touch). The diff below would
            // drop an untouched color, leaving the card uncolored.
            patch.title = title.trim();
            patch.description = description;
            patch.color = color;
            if (drafts.length > 0) attachments = drafts;
        } else {
            if (title !== initialTitle) patch.title = title;
            if (description !== canonicalInitialDescription.current) patch.description = description;
            if (color !== initialColor) patch.color = color;
            if (draftsChanged) attachments = drafts;
        }
        setIsSubmitting(true);
        try {
            await onSave(patch, attachments);
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} onPaste={handlePaste} {...dropProps}>
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
                <AttachmentDraftChips
                    items={drafts}
                    onRemove={(i) => setDrafts((prev) => prev.filter((_, j) => j !== i))}
                />
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
                {allowAttachments && (
                    <>
                        <TooltipButton
                            icon={Paperclip}
                            tooltipText="Add attachment"
                            variant="outline"
                            className="mr-auto h-9 w-9 text-muted-foreground hover:text-foreground"
                            onClick={() => setPickerOpen(true)}
                            type="button"
                        />
                        <DrivePickerWithUpload
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                            multiSelect
                            multiple
                            onPickFromDrive={(paths) => setDrafts((prev) => [...prev, ...paths])}
                            onPickFromDevice={(files) => setDrafts((prev) => [...prev, ...files])}
                        />
                    </>
                )}
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
    allowAttachments = false,
    initialAttachments = [],
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
                        allowAttachments={allowAttachments}
                        initialAttachments={initialAttachments}
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
