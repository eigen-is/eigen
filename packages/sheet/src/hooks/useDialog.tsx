// How the sheet opens a dialog in the one slot ModalProvider holds. Each dialog, such as Custom sort, draws its own
// FormDialog and takes its open and close from useDialogProps. A yes or no, such as a sheet delete, is a ConfirmDialog
// that showConfirm opens there. The range picker opens non-modal, so the grid stays usable to pick on.

import type { ConfirmDialogProps } from '@workspace/ui/components/confirm-dialog';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { useCallback, useContext } from 'react';
import type { DialogProps } from '../context/modal';
import { DialogPropsContext, ModalContext } from '../context/modal';

type ConfirmOptions = Omit<ConfirmDialogProps, keyof DialogProps>;

export function useDialog() {
    const { showModal, showNonModal, pickerOpen } = useContext(ModalContext);

    const showConfirm = useCallback(
        (options: ConfirmOptions) => showModal(<SlotConfirmDialog {...options} />),
        [showModal],
    );

    return { showDialog: showModal, showConfirm, showNonModalDialog: showNonModal, pickerOpen };
}

// The open and close of the dialog in the slot, for its FormDialog to spread.
export function useDialogProps(): DialogProps {
    return useContext(DialogPropsContext);
}

function SlotConfirmDialog(options: ConfirmOptions) {
    return <ConfirmDialog {...useDialogProps()} {...options} />;
}
