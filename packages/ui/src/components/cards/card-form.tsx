// The form that adds or edits a comment card or a sticky: title, description, attachments, color and assignee. It only
// stages them; the host saves them on submit and uploads the attachments, and Cancel touches nothing. Editing can
// offer Delete, which the host confirms.

import { wasToasted } from '@workspace/lib/api-error';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { Button } from '@workspace/ui/components/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Paperclip, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { AssigneeChip } from '../comments/assignee-chip';
import { AssigneePicker } from '../comments/assignee-picker';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { ColorPicker } from '../media/color-picker';

type CardFormProps = {
    // Edit hands on only the changed fields, so an unchanged save writes nothing. Create always hands on a trimmed
    // title and a color, so a new card is never untitled or uncolored.
    mode?: 'create' | 'edit';
    initialTitle?: string;
    initialDescription?: string;
    initialColor?: string;
    // Attachments are only staged: the host uploads or copies them on save, and Cancel touches nothing.
    allowAttachments?: boolean;
    initialAttachments?: ChatAttachment[];
    // The assignee row shows only with both members and currentUserEmail.
    members?: EffectiveMember[];
    currentUserEmail?: string;
    initialAssignee?: string | null;
    onSave: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        // Undefined when untouched, so the host skips the assignment.
        assignee?: string | null,
    ) => void | Promise<void>;
    onCancel: () => void;
    // Editing only. The host confirms and deletes, and what was typed stays until it does.
    onDelete?: () => void;
    // A title above the form. A host that has its own, such as the card dialog, omits it.
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
    onDelete,
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
    // The editor rewrites a plain-text description as HTML as it loads. A save with no edits compares against that
    // form, or it would write the rewrite back.
    const canonicalInitialDescription = useRef(initialDescription);

    const stageFiles = (files: File[]) => setDrafts((prev) => [...prev, ...files]);
    const { targetProps } = useFileDropTarget(stageFiles, allowAttachments);
    const { onPaste } = useFilePasteTarget(stageFiles, allowAttachments);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;
        const patch: CardFormPatch = {};
        // Edit mode seeds the drafts with the card's own attachments, so comparing by identity finds any change.
        const draftsChanged =
            drafts.length !== initialAttachments.length || drafts.some((d, i) => d !== initialAttachments[i]);
        let attachments: CardAttachmentDraft[] | undefined;
        let assigneeArg: string | null | undefined;
        if (mode === 'create') {
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
        } catch (error) {
            // A mutation's failure is toasted already, so the form stays open for a retry. Anything else, such as a
            // Yjs write, has no toast and must surface.
            if (!wasToasted(error)) throw error;
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} onPaste={onPaste} className="flex min-h-0 flex-1 flex-col" {...targetProps}>
            {dialogTitle && (
                <DialogHeader>
                    <DialogTitle>{dialogTitle}</DialogTitle>
                    {/* Radix requires a description on every DialogContent; the fields carry their own labels. */}
                    <DialogDescription className="sr-only">
                        Set the card's title, description and color.
                    </DialogDescription>
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
                {/* min-w-0 keeps this row from widening the grid past the dialog, and on a phone the assignee wraps
                    to its own line. */}
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
            <DialogFooter
                start={
                    <>
                        {allowAttachments && (
                            <>
                                <TooltipButton
                                    icon={Paperclip}
                                    tooltipText="Add attachment"
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
                        {onDelete && (
                            <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} type="button" />
                        )}
                    </>
                }
            >
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
