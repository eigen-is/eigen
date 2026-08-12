import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { LightEditor } from '@workspace/ui/components/layout/editor/light-editor';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFileDropTarget } from '../../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../../hooks/use-file-paste-target';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { AssigneeChip } from '../comments/assignee-chip';
import { AssigneePicker } from '../comments/assignee-picker';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { ColorPicker } from '../media/color-picker';

type CardFormProps = {
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
    // Assignee staging renders only when both members and currentUserEmail are provided.
    members?: EffectiveMember[];
    currentUserEmail?: string;
    initialAssignee?: string | null;
    onSave: (
        patch: { title?: string; description?: string; color?: string },
        attachments?: CardAttachmentDraft[],
        // undefined = untouched; the host skips the assignment PATCH.
        assignee?: string | null,
    ) => void | Promise<void>;
    onCancel: () => void;
    // When set, renders a DialogHeader/DialogTitle atop the form (dialog use). Omit
    // for in-place edit, where the host dialog already owns the title.
    dialogTitle?: string;
    placeholderTitle?: string;
    placeholderDescription?: string;
    submitLabel?: string;
};

export function CardForm({
    mode = 'create',
    initialTitle = '',
    initialDescription = '',
    initialColor = EIGEN_STICKIES_COLORS[0][1].value,
    allowAttachments = false,
    initialAttachments = [],
    members,
    currentUserEmail,
    initialAssignee = null,
    onSave,
    onCancel,
    dialogTitle,
    placeholderTitle = 'Enter title',
    placeholderDescription = 'Enter description',
    submitLabel = 'Save',
}: CardFormProps) {
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState(initialDescription);
    const [color, setColor] = useState(initialColor);
    const [assignee, setAssignee] = useState<string | null>(initialAssignee);
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
    const { targetProps } = useFileDropTarget(stageFiles, allowAttachments);
    const { onPaste } = useFilePasteTarget(stageFiles, allowAttachments);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        const patch: { title?: string; description?: string; color?: string } = {};
        // Edit mode seeds drafts with the existing ChatAttachment objects, so identity
        // compare detects any removal/addition without a deep equality pass.
        const draftsChanged =
            drafts.length !== initialAttachments.length || drafts.some((d, i) => d !== initialAttachments[i]);
        let attachments: CardAttachmentDraft[] | undefined;
        // undefined = untouched assignee; the host skips the assignment PATCH.
        let assigneeArg: string | null | undefined;
        if (mode === 'create') {
            // A new card must carry concrete values: a trimmed title and the
            // seeded color (which the user may never touch). The diff below would
            // drop an untouched color, leaving the card uncolored.
            patch.title = title.trim();
            patch.description = description;
            patch.color = color;
            if (drafts.length > 0) attachments = drafts;
            assigneeArg = assignee ?? undefined;
        } else {
            if (title !== initialTitle) patch.title = title;
            if (description !== canonicalInitialDescription.current) patch.description = description;
            if (color !== initialColor) patch.color = color;
            if (draftsChanged) attachments = drafts;
            assigneeArg = assignee !== initialAssignee ? assignee : undefined;
        }
        setIsSubmitting(true);
        try {
            await onSave(patch, attachments, assigneeArg);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} onPaste={onPaste} className="flex min-h-0 flex-1 flex-col" {...targetProps}>
            {dialogTitle && (
                <DialogHeader>
                    <DialogTitle>{dialogTitle}</DialogTitle>
                </DialogHeader>
            )}
            {/* Fields scroll so the footer stays pinned on short viewports. */}
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto py-4">
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
                            className="min-h-[120px]"
                        />
                    </div>
                </div>
                <AttachmentDraftChips
                    items={drafts}
                    onRemove={(i) => setDrafts((prev) => prev.filter((_, j) => j !== i))}
                />
                {/* min-w-0: as a grid item this row's min-content width would otherwise widen the
                    whole track past the dialog (clipping every field's right edge). flex-wrap drops
                    the Assignee onto its own line at phone widths so all 8 swatches and the full
                    assignee button stay visible; on desktop it stays one line, unchanged. */}
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
                    <div className="flex shrink-0 items-center gap-2">
                        <Label>Color</Label>
                        <ColorPicker
                            value={color}
                            onChange={setColor}
                            colors={EIGEN_STICKIES_COLORS}
                            columns={EIGEN_STICKIES_COLORS[0].length}
                            showReset={false}
                        />
                    </div>
                    {members && currentUserEmail && (
                        <div className="flex min-w-0 items-center gap-2">
                            <Label>Assignee</Label>
                            <AssigneePicker
                                value={assignee}
                                onChange={setAssignee}
                                members={members}
                                currentUserEmail={currentUserEmail}
                            >
                                <button
                                    type="button"
                                    className="flex w-fit min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm hover:bg-muted"
                                >
                                    {assignee ? (
                                        <AssigneeChip email={assignee} />
                                    ) : (
                                        <span className="text-muted-foreground">Unassigned</span>
                                    )}
                                </button>
                            </AssigneePicker>
                        </div>
                    )}
                </div>
            </div>
            <DialogFooter className="pt-2">
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
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!title.trim() || isSubmitting}>
                    {isSubmitting ? 'Saving...' : submitLabel}
                </Button>
            </DialogFooter>
        </form>
    );
}
