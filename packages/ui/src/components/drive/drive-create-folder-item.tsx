// The small dialog that asks for one name, such as a new folder's in a Drive picker or the new name Rename gives an
// item. It shows the folder it works in under the field. Create waits for a name with more than spaces and hands the
// name on as typed. The caller's promise decides the rest: a save closes the dialog, and a failure keeps it open with
// the typed name, beside the mutation's toast.

import { useBreadcrumb } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';
import { useOptionalPreview } from '../preview-provider/preview-context';

// The word the title, the label and the placeholder use for the item.
type ItemType = 'Folder' | 'File';

type DriveCreateItemDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Rejects when the save fails, which keeps the dialog open.
    onCreateItem: (itemName: string) => Promise<unknown>;
    type: ItemType;
    path: DrivePath;
    title?: string;
    defaultValue?: string;
    confirmLabel?: string;
};

export function DriveCreateItemDialog({
    open,
    onOpenChange,
    onCreateItem,
    type,
    path,
    title,
    defaultValue = '',
    confirmLabel = 'Create',
}: DriveCreateItemDialogProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(path.ownerId, path.mountId, open ? path.id : undefined);
    // Opened over a file preview, such as New folder in Save to Drive's picker, it has to sit above that preview.
    const preview = useOptionalPreview();

    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={title || `New ${type.toLowerCase()}`}
            abovePreview={preview?.isPreviewOpen}
        >
            <ItemNameForm
                type={type}
                defaultValue={defaultValue}
                submitLabel={confirmLabel}
                location={breadcrumbPaths.map((crumb) => crumb.name || 'Drive').join(' > ')}
                onCreateItem={onCreateItem}
            />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from the default name.
function ItemNameForm({
    type,
    defaultValue,
    submitLabel,
    location,
    onCreateItem,
}: {
    type: ItemType;
    defaultValue: string;
    submitLabel: string;
    location: string;
    onCreateItem: (itemName: string) => Promise<unknown>;
}) {
    const [itemName, setItemName] = useState(defaultValue);

    return (
        <FormDialogForm
            canSubmit={itemName.trim() !== ''}
            submitLabel={submitLabel}
            onSubmit={async () => {
                await onCreateItem(itemName);
            }}
        >
            <Field>
                <FieldLabel htmlFor="itemName">{type} name</FieldLabel>
                <Input
                    id="itemName"
                    value={itemName}
                    onChange={(e) => setItemName(e.target.value)}
                    placeholder={`Enter ${type.toLowerCase()} name`}
                    autoFocus
                />
            </Field>
            <Field>
                <FieldTitle>Location</FieldTitle>
                <FieldDescription className="truncate">{location}</FieldDescription>
            </Field>
        </FormDialogForm>
    );
}
