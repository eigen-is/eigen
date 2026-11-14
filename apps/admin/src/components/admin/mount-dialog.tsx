// The admin's Add mount and Edit mount dialogs for a team's Drive mounts. The team's storage section opens them and
// saves through its mount hooks. This file draws the dialog shell; the mount fields and their state live in MountForm,
// which mounts with each opening.

import { FormDialog } from '@workspace/ui/components/form-dialog';
import { MountForm } from '@workspace/ui/components/mount';
import type { ComponentProps } from 'react';

type MountDialogProps = ComponentProps<typeof MountForm> & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
};

export function MountDialog({ open, onOpenChange, title, ...formProps }: MountDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title={title} size="sm">
            <MountForm {...formProps} />
        </FormDialog>
    );
}
