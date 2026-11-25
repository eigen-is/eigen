// The dialog that renames a column of a board or deletes it, after a confirmation. It writes to the board's
// Yjs document itself. A delete takes the column's cards with it, as one undo step.

import { getIdArray, getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import * as Y from 'yjs';

type ColumnSettingsDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    columnId: string;
    columnTitle: string;
    cardCount: number;
    yjsDoc: Y.Doc | null;
    // Seals the column delete as its own undo step.
    undoManager: Y.UndoManager | null;
};

export function ColumnSettingsDialog({
    open,
    onOpenChange,
    columnId,
    columnTitle,
    cardCount,
    yjsDoc,
    undoManager,
}: ColumnSettingsDialogProps) {
    // The column as the confirmation opened, so its sentence stays while it fades out after the delete.
    const deleteConfirm = useDialogValue<{ title: string; cardCount: number }>();
    const deleting = deleteConfirm.value;

    const handleDelete = () => {
        if (!yjsDoc) return;

        undoManager?.stopCapturing();
        yjsDoc.transact(() => {
            const columnsMap = getItemMapRoot(yjsDoc, 'columns');
            const tasksMap = yjsDoc.getMap('tasks');
            const columnOrderArray = getIdArrayRoot(yjsDoc, 'columnOrder');

            const columnMap = columnsMap.get(columnId);
            if (!columnMap) return;

            const taskIdsArray = getIdArray(columnMap, 'taskIds');
            if (taskIdsArray) {
                for (const taskId of taskIdsArray.toArray()) {
                    tasksMap.delete(taskId);
                }
            }

            const columnOrder = columnOrderArray.toArray();
            const columnIndex = columnOrder.indexOf(columnId);
            if (columnIndex !== -1) columnOrderArray.delete(columnIndex, 1);

            columnsMap.delete(columnId);
        });
        undoManager?.stopCapturing();

        onOpenChange(false);
    };

    return (
        <>
            <FormDialog open={open} onOpenChange={onOpenChange} title="Column settings">
                <ColumnSettingsForm
                    columnId={columnId}
                    columnTitle={columnTitle}
                    yjsDoc={yjsDoc}
                    onDelete={() => deleteConfirm.openDialog({ title: columnTitle, cardCount })}
                />
            </FormDialog>

            {deleting && (
                <ConfirmDialog
                    open={deleteConfirm.open}
                    onOpenChange={deleteConfirm.setOpen}
                    title="Delete column"
                    description={
                        <>
                            This will delete the column <strong>{deleting.title}</strong>
                            {deleting.cardCount > 0 &&
                                ` and ${deleting.cardCount} ${deleting.cardCount === 1 ? 'card' : 'cards'} within it`}
                            . You can undo this straight after, until you close the board.
                        </>
                    }
                    onConfirm={handleDelete}
                    confirmText="Delete"
                    destructive
                />
            )}
        </>
    );
}

// Mounted with the dialog, so each opening starts from the column's title.
function ColumnSettingsForm({
    columnId,
    columnTitle,
    yjsDoc,
    onDelete,
}: Pick<ColumnSettingsDialogProps, 'columnId' | 'columnTitle' | 'yjsDoc'> & { onDelete: () => void }) {
    const [openedTitle] = useState(columnTitle);
    const [title, setTitle] = useState(columnTitle);

    const handleSubmit = () => {
        if (!yjsDoc || !title.trim()) return false;

        yjsDoc.transact(() => {
            const columnMap = getItemMapRoot(yjsDoc, 'columns').get(columnId);
            if (columnMap instanceof Y.Map) columnMap.set('title', title.trim());
        });
    };

    return (
        <FormDialogForm
            changed={title !== openedTitle}
            submitLabel="Save"
            onSubmit={handleSubmit}
            footerStart={<TooltipButton icon={Trash2} tooltipText="Delete column" onClick={onDelete} />}
        >
            <RequiredTextField label="Title" value={title} onChange={setTitle} message={FIELD_MESSAGES.titleMissing} />
        </FormDialogForm>
    );
}
