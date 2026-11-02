// How the sheet opens its dialogs in the one slot ModalProvider holds: a notice or a yes or no, such as a refused edit
// or a delete confirm, a dialog on FormDialog such as Custom sort, a dialog in the shared shell, or the range picker
// that leaves the grid usable. A dialog on FormDialog takes its open and close from useDialogProps.

import { Button } from '@workspace/ui/components/button';
import { DialogDescription, DialogFooter } from '@workspace/ui/components/dialog';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import type React from 'react';
import { useCallback, useContext } from 'react';
import type { DialogProps, ModalOptions } from '../context/modal';
import { DialogPropsContext, ModalContext } from '../context/modal';

export function useDialog() {
    const { showModal, hideModal } = useContext(ModalContext);

    // With a type, the content is the message of a notice, and onOk runs before the notice closes.
    const showDialog = useCallback(
        (content: React.ReactNode, type?: 'ok' | 'yesno', onOk?: () => void) => {
            if (type) {
                showModal(
                    <NoticeDialog type={type} onOk={onOk}>
                        {content}
                    </NoticeDialog>,
                    { ownsDialog: true },
                );
            } else {
                showModal(content);
            }
        },
        [showModal],
    );

    const showFormDialog = useCallback(
        (content: React.ReactNode) => showModal(content, { ownsDialog: true }),
        [showModal],
    );

    const showNonModalDialog = useCallback(
        (content: React.ReactNode, options: Omit<ModalOptions, 'modal'> = {}) => {
            showModal(content, { ...options, modal: false });
        },
        [showModal],
    );

    return { showDialog, showFormDialog, showNonModalDialog, hideDialog: hideModal };
}

// The open and close of the dialog in the slot, for its FormDialog to spread.
export function useDialogProps(): DialogProps {
    return useContext(DialogPropsContext);
}

function NoticeDialog({
    type,
    onOk,
    children,
}: {
    type: 'ok' | 'yesno';
    onOk?: () => void;
    children: React.ReactNode;
}) {
    const dialogProps = useDialogProps();
    const close = () => dialogProps.onOpenChange(false);

    return (
        <FormDialog {...dialogProps} title="Notice" size="md">
            <DialogDescription className="text-foreground">{children}</DialogDescription>
            <DialogFooter>
                {type === 'yesno' && (
                    <Button variant="outline" onClick={close}>
                        Cancel
                    </Button>
                )}
                <Button
                    onClick={() => {
                        onOk?.();
                        close();
                    }}
                >
                    OK
                </Button>
            </DialogFooter>
        </FormDialog>
    );
}
