// The state of a dialog that is opened by a value, such as the item to rename or the rows to delete: whether it is
// open, and the value it was last opened with. Closing keeps the value, so the dialog still shows its text while it
// fades out, and the next open replaces it. The component that owns such a dialog calls this, as the Drive action
// runner does for each of its own, and mounts the dialog once there is a value.

import { useState } from 'react';

export function useDialogValue<T>(): {
    open: boolean;
    value: T | undefined;
    setOpen: (open: boolean) => void;
    openDialog: (value: T) => void;
} {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState<T>();

    const openDialog = (next: T) => {
        setValue(next);
        setOpen(true);
    };

    return { open, value, setOpen, openDialog };
}
