// The dialog that adds a comment card or a sticky: the open card's dialog without its thread. The title is typed into
// the header, which takes the picked color, then come the description, attachments, color and assignee. It only holds
// them: the host saves the card on Add and uploads the attachments, and Cancel touches nothing.

import { wasToasted } from '@workspace/lib/api-error';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { CardAttachmentDraft, CardFormPatch } from '@workspace/lib/types/comments';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { useId, useState } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { Button } from '../button';
import { DialogTitle } from '../dialog';
import { DrivePickerWithUpload } from '../drive/drive-picker-with-upload';
import { CardAttachmentRow } from './card-attachment-row';
import { CardDescriptionEditor } from './card-description';
import { CardDialogShell } from './card-dialog-shell';
import { CardProperties } from './card-properties';
import { CardTitleInput } from './card-title';

type NewCardDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // In the labels, such as "Add sticky".
    noun?: string;
    initialTitle?: string;
    allowAttachments: boolean;
    members?: EffectiveMember[];
    currentUserEmail?: string;
    // An untouched assignee is undefined, so the host sends no assignment.
    onSave: (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string) => void | Promise<void>;
};

// Each opening starts from empty fields, and from the title the host passes then, such as a docs selection. The form
// remounts as the dialog opens rather than unmounting as it closes, so the dialog keeps its closing animation.
export function NewCardDialog(props: NewCardDialogProps) {
    const [opening, setOpening] = useState(0);
    const [wasOpen, setWasOpen] = useState(props.open);
    if (props.open !== wasOpen) {
        setWasOpen(props.open);
        if (props.open) setOpening((n) => n + 1);
    }
    return <NewCardForm key={opening} {...props} />;
}

function NewCardForm({
    open,
    onOpenChange,
    noun = 'comment',
    initialTitle = '',
    allowAttachments,
    members,
    currentUserEmail,
    onSave,
}: NewCardDialogProps) {
    const formId = useId();
    const [title, setTitle] = useState(initialTitle);
    const [description, setDescription] = useState('');
    const [color, setColor] = useState(EIGEN_STICKIES_COLORS[0][1].value);
    const [assignee, setAssignee] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<CardAttachmentDraft[]>([]);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const stage = (added: CardAttachmentDraft[]) => setDrafts((prev) => [...prev, ...added]);
    const { targetProps } = useFileDropTarget(stage, allowAttachments);
    const { onPaste } = useFilePasteTarget(stage, allowAttachments);
    const unsaved = title.trim() !== initialTitle.trim() || description !== '' || drafts.length > 0;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await onSave(
                { title: title.trim(), description, color },
                drafts.length > 0 ? drafts : undefined,
                assignee ?? undefined,
            );
            onOpenChange(false);
        } catch (error) {
            // A failed mutation is toasted by its hook, and the dialog stays for a retry. Anything else, such as a
            // Yjs write or the host's anchor, is silent otherwise.
            if (!wasToasted(error)) throw error;
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <CardDialogShell
            open={open}
            onOpenChange={onOpenChange}
            color={color}
            unsaved={unsaved}
            onCancel={() => onOpenChange(false)}
            title={
                <>
                    <DialogTitle className="sr-only">New {noun}</DialogTitle>
                    <CardTitleInput
                        form={formId}
                        autoFocus
                        placeholder="Title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </>
            }
            footer={
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="submit" form={formId} disabled={!title.trim() || isSubmitting}>
                        Add {noun}
                    </Button>
                </div>
            }
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                onPaste={onPaste}
                onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.requestSubmit();
                }}
                className="flex flex-col gap-4"
                {...targetProps}
            >
                <CardDescriptionEditor content="" onChange={setDescription} editorClassName="min-h-[160px]" />
                <CardAttachmentRow
                    onAdd={allowAttachments ? () => setPickerOpen(true) : undefined}
                    hasAttachments={drafts.length > 0}
                >
                    <AttachmentDraftChips
                        items={drafts}
                        onRemove={(i) => setDrafts((prev) => prev.filter((_, j) => j !== i))}
                        className="min-w-0 flex-1"
                    />
                </CardAttachmentRow>
                {allowAttachments && (
                    <DrivePickerWithUpload
                        open={pickerOpen}
                        onOpenChange={setPickerOpen}
                        multiSelect
                        multiple
                        onPickFromDrive={stage}
                        onPickFromDevice={stage}
                    />
                )}
                <CardProperties
                    color={color}
                    onColorChange={setColor}
                    assignee={assignee}
                    onAssigneeChange={setAssignee}
                    members={members}
                    currentUserEmail={currentUserEmail}
                />
            </form>
        </CardDialogShell>
    );
}
