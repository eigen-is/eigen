// The form that adds or edits a card, a comment's or a board's: title, description, attachments, color and
// assignee. It only stages them; the host saves them on submit and uploads the attachments, and Cancel touches
// nothing. It is on FormShell's keys, so Cmd+Enter saves from any field, and Save with no title says so under the
// field. It tells its host whether anything changed, so the host's Esc can ask before it drops the edit. Editing can
// offer Delete, which the host confirms.

import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { ChatAttachment } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { LightEditor } from '@workspace/ui/components/editor/light-editor';
import { FieldError } from '@workspace/ui/components/field';
import { FormFooter } from '@workspace/ui/components/form-dialog';
import { FormShell, useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Paperclip, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { DialogAction } from '../../hooks/use-dialog-pending';
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
    allowAttachments?: boolean;
    initialAttachments?: ChatAttachment[];
    // The assignee row shows only with both members and currentUserEmail.
    members?: EffectiveMember[];
    currentUserEmail?: string;
    initialAssignee?: string | null;
    // The host runs it through its pending lifecycle, which says `pending` while it runs.
    onSave: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        // Undefined when untouched, so the host skips the assignment.
        assignee?: string | null,
    ) => ReturnType<DialogAction>;
    pending: boolean;
    onCancel: () => void;
    onChangedChange?: (changed: boolean) => void;
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
    pending,
    onCancel,
    onChangedChange,
    onDelete,
    dialogTitle,
    placeholderTitle = 'Enter title',
    placeholderDescription = 'Enter description',
    submitLabel = 'Save',
}: CardFormProps) {
    // What the form opened with. A value the host learns later, such as the card's assignee, leaves an open edit alone,
    // or a fresh edit would read as changed and its Save would undo what the host learned.
    const [initial] = useState(() => ({
        title: initialTitle,
        description: initialDescription,
        color: initialColor,
        assignee: initialAssignee,
        attachments: initialAttachments,
    }));
    const [title, setTitle] = useState(initial.title);
    const [description, setDescription] = useState(initial.description);
    const [color, setColor] = useState(initial.color);
    const [assignee, setAssignee] = useState(initial.assignee);
    const [drafts, setDrafts] = useState<CardAttachmentDraft[]>(initial.attachments);
    const [pickerOpen, setPickerOpen] = useState(false);
    // The editor rewrites a plain-text description as HTML as it loads. A save with no edits compares against that
    // form, or it would write the rewrite back.
    const [loadedDescription, setLoadedDescription] = useState(initial.description);
    const descriptionLabelId = useId();

    // Edit mode seeds the drafts with the card's own attachments, so comparing by identity finds any change.
    const draftsChanged =
        drafts.length !== initial.attachments.length || drafts.some((d, i) => d !== initial.attachments[i]);
    const changed =
        title !== initial.title ||
        description !== loadedDescription ||
        color !== initial.color ||
        assignee !== initial.assignee ||
        draftsChanged;
    useEffect(() => {
        onChangedChange?.(changed);
        return () => onChangedChange?.(false);
    }, [changed, onChangedChange]);

    const stageFiles = (files: File[]) => setDrafts((prev) => [...prev, ...files]);
    const { targetProps } = useFileDropTarget(stageFiles, allowAttachments);
    const { onPaste } = useFilePasteTarget(stageFiles, allowAttachments);

    const handleSubmit = () => {
        if (!title.trim()) return false;
        const patch: CardFormPatch = {};
        let attachments: CardAttachmentDraft[] | undefined;
        let assigneeArg: string | null | undefined;
        if (mode === 'create') {
            patch.title = title.trim();
            patch.description = description;
            patch.color = color;
            if (drafts.length > 0) attachments = drafts;
            assigneeArg = assignee ?? undefined;
        } else {
            if (title !== initial.title) patch.title = title;
            if (description !== loadedDescription) patch.description = description;
            if (color !== initial.color) patch.color = color;
            if (draftsChanged) attachments = drafts;
            assigneeArg = assignee !== initial.assignee ? assignee : undefined;
        }
        return onSave(patch, attachments, assigneeArg);
    };

    return (
        <FormShell onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
            {/* The drop and paste targets take files anywhere on the form. */}
            <div onPaste={onPaste} className="flex min-h-0 flex-1 flex-col" {...targetProps}>
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
                    <TitleField value={title} onChange={setTitle} placeholder={placeholderTitle} />
                    <div className="grid gap-2">
                        <Label id={descriptionLabelId}>Description</Label>
                        <div className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-within:ring-[3px] focus-within:ring-ring/50">
                            <LightEditor
                                content={initial.description}
                                onChange={setDescription}
                                onReady={({ html }) => {
                                    setLoadedDescription(html);
                                    setDescription(html);
                                }}
                                labelledBy={descriptionLabelId}
                                submitOnModEnter
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
                <FormFooter
                    pending={pending}
                    onCancel={onCancel}
                    submitLabel={submitLabel}
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
                />
            </div>
        </FormShell>
    );
}

// The title a card can't do without. Once Save was pressed, an empty one says so under the field.
function TitleField({
    value,
    onChange,
    placeholder,
}: {
    value: string;
    onChange: (title: string) => void;
    placeholder: string;
}) {
    const id = useId();
    const missing = useFormSubmitted() && !value.trim();
    return (
        <div className="grid gap-2">
            <Label htmlFor={id}>Title</Label>
            <Input
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoFocus
                aria-invalid={missing || undefined}
            />
            {missing && <FieldError>Add a title</FieldError>}
        </div>
    );
}
