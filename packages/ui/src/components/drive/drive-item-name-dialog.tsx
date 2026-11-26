// The small dialog that asks for one name, such as a new folder's in a Drive picker or the new name Rename gives an
// item. It shows the folder it works in under the field. Its submit button, Create unless the caller names it, hands
// the name on as typed; a name of only spaces, or one a sibling has already, gets its reason under the field instead.
// The field opens with its name selected, or the start of it the caller asks for, so typing replaces it. The caller's
// promise decides the rest: a save closes the dialog, and a failure keeps it open with the typed name.

import { isNameTaken } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { Field, FieldDescription, FieldTitle } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import type { RefObject } from 'react';
import { useRef, useState } from 'react';

// The word the title, the label and the placeholder use for the item.
type ItemType = 'Folder' | 'File';

type DriveItemNameDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Rejects when the save fails, which keeps the dialog open.
    onSave: (itemName: string) => Promise<unknown>;
    type: ItemType;
    // The crumbs of the folder the item is or goes in, from the drive's root.
    folder: readonly DrivePath[];
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
    folder,
    title,
    defaultValue = '',
    selectionEnd = defaultValue.length,
    submitLabel = 'Create',
}: DriveItemNameDialogProps) {
    const fieldRef = useRef<HTMLInputElement>(null);
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={title || `New ${type.toLowerCase()}`}
            // The dialog's focus trap places the focus once a closing menu has let go of it. A field that took the focus
            // earlier would lose it to that menu, and the trap would take it back with the whole name selected.
            onOpenAutoFocus={(event) => {
                event.preventDefault();
                fieldRef.current?.focus();
                fieldRef.current?.setSelectionRange(0, selectionEnd);
            }}
        >
            <ItemNameForm
                fieldRef={fieldRef}
                type={type}
                defaultValue={defaultValue}
                submitLabel={submitLabel}
                location={folder.map((crumb) => crumb.name || 'Drive').join(' > ')}
                onSave={onSave}
            />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from the default name.
function ItemNameForm({
    fieldRef,
    type,
    defaultValue,
    submitLabel,
    location,
    onSave,
}: {
    fieldRef: RefObject<HTMLInputElement | null>;
    type: ItemType;
    defaultValue: string;
    submitLabel: string;
    location: string;
    onSave: (itemName: string) => Promise<unknown>;
}) {
    const [itemName, setItemName] = useState(defaultValue);
    // The server's reason for the name last sent, until the name changes.
    const [taken, setTaken] = useState<string>();

    return (
        <FormDialogForm
            changed={itemName !== defaultValue}
            submitLabel={submitLabel}
            onSubmit={async () => {
                if (!itemName.trim()) return false;
                try {
                    await onSave(itemName);
                } catch (error) {
                    if (!isNameTaken(error)) throw error;
                    setTaken(error.message);
                    return false;
                }
            }}
        >
            <RequiredTextField
                ref={fieldRef}
                label={`${type} name`}
                placeholder={`Enter ${type.toLowerCase()} name`}
                value={itemName}
                onChange={(name) => {
                    setItemName(name);
                    setTaken(undefined);
                }}
                message={FIELD_MESSAGES.nameMissing}
                error={taken}
            />
            <Field>
                <FieldTitle>Location</FieldTitle>
                <FieldDescription className="truncate">{location}</FieldDescription>
            </Field>
        </FormDialogForm>
    );
}
