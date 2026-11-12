// The open state of every dialog a Drive view's actions open, such as rename, share or the copy and
// move picker, with the items each one acts on. The Drive action runner opens them and renders them.

import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { useState } from 'react';

function useDialogState() {
    const [open, setOpen] = useState(false);
    return { open, setOpen, openDialog: () => setOpen(true) };
}

// One dialog-open state per EigenDocType. Each entry is its own useState pair (the rules of hooks), so
// they are listed by hand under one key.
function useEigenDocDialogs(): Record<EigenDocType, ReturnType<typeof useDialogState>> {
    return {
        doc: useDialogState(),
        stickies: useDialogState(),
        slides: useDialogState(),
        sheets: useDialogState(),
        chat: useDialogState(),
        vector: useDialogState(),
    };
}

export function useDriveDialogs() {
    return {
        createFolder: useDialogState(),
        create: useEigenDocDialogs(),
        delete: useDialogValue<readonly DrivePath[]>(),
        rename: useDialogValue<DrivePath>(),
        share: useDialogValue<DrivePath>(),
        email: useDialogValue<DrivePath>(),
        upload: useDialogValue<File[]>(),
        copyMove: useDialogValue<{ items: readonly DrivePath[]; mode: 'move' | 'copy' }>(),
    };
}
