// The small dialog that asks for one name, such as a new folder's in a Drive picker or the new name Rename gives an
// item. It shows the folder it works in under the field. Its submit button, Create unless the caller names it, waits
// for a name with more than spaces and hands the name on as typed. The field opens with its name selected, or the
// start of it the caller asks for, so typing replaces it. The caller's promise decides the rest: a save closes the
// dialog, and a failure keeps it open with the typed name, beside the mutation's toast.

import { useBreadcrumb } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Field, FieldDescription, FieldLabel, FieldTitle } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useLayoutEffect, useRef, useState } from 'react';

// The word the title, the label and the placeholder use for the item.
type ItemType = 'Folder' | 'File';

type DriveItemNameDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Rejects when the save fails, which keeps the dialog open.
    onSave: (itemName: string) => Promise<unknown>;
    type: ItemType;
    path: DrivePath;
    title?: string;
    defaultValue?: string;
    selectionEnd?: number;
    submitLabel?: string;
};

export function DriveItemNameDialog({
    open,
    onOpenChange,
    onSave,
    type,
    path,
    title,
    defaultValue = '',
    selectionEnd = defaultValue.length,
    submitLabel = 'Create',
}: DriveItemNameDialogProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(path.ownerId, path.mountId, open ? path.id : undefined);
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title={title || `New ${type.toLowerCase()}`}>
            <ItemNameForm
                type={type}
                defaultValue={defaultValue}
                selectionEnd={selectionEnd}
                submitLabel={submitLabel}
                location={breadcrumbPaths.map((crumb) => crumb.name || 'Drive').join(' > ')}
                onSave={onSave}
            />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from the default name.
function ItemNameForm({
    type,
    defaultValue,
    selectionEnd,
    submitLabel,
    location,
    onSave,
}: {
    type: ItemType;
    defaultValue: string;
    selectionEnd: number;
    submitLabel: string;
    location: string;
    onSave: (itemName: string) => Promise<unknown>;
}) {
    const [itemName, setItemName] = useState(defaultValue);
    // Selected here, so the field opens alike from a menu, a row's ⋮ or the command palette, whichever way the focus
    // arrived.
    const fieldRef = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        fieldRef.current?.setSelectionRange(0, selectionEnd);
    }, [selectionEnd]);

    return (
        <FormDialogForm
            canSubmit={itemName.trim() !== ''}
            submitLabel={submitLabel}
            onSubmit={async () => {
                await onSave(itemName);
            }}
        >
            <Field>
                <FieldLabel htmlFor="itemName">{type} name</FieldLabel>
                <Input
                    ref={fieldRef}
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
