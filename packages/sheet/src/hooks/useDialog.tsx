// How the sheet opens a dialog in the one slot ModalProvider holds. Each dialog, such as Custom sort, draws its own
// FormDialog and takes its open and close from useDialogProps. A notice or a yes or no, such as a refused edit or a
// delete confirm, is a message with a type. The range picker opens non-modal, so the grid stays usable to pick on.

import { Button } from '@workspace/ui/components/button';
import { DialogDescription, DialogFooter } from '@workspace/ui/components/dialog';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import type React from 'react';
import { useCallback, useContext } from 'react';
import type { DialogProps } from '../context/modal';
import { DialogPropsContext, ModalContext } from '../context/modal';

export function useDialog() {
    const { showModal, showNonModal, hideModal } = useContext(ModalContext);

    // With a type, the content is the message of a notice, and onOk runs before the notice closes.
    const showDialog = useCallback(
        (content: React.ReactNode, type?: 'ok' | 'yesno', onOk?: () => void) => {
            if (!type) {
                showModal(content);
                return;
            }
            showModal(
                <NoticeDialog type={type} onOk={onOk}>
                    {content}
                </NoticeDialog>,
            );
        },
        [showModal],
    );

    return { showDialog, showNonModalDialog: showNonModal, hideDialog: hideModal };
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
