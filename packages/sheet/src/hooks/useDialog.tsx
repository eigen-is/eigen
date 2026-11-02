// How the sheet opens a dialog in the one slot ModalProvider holds. Each dialog, such as Custom sort, draws its own
// FormDialog and takes its open and close from useDialogProps. A notice or a yes or no, such as a refused edit or a
// delete confirm, is a message that showNotice draws. The range picker opens non-modal, so the grid stays usable to
// pick on.

import { Button } from '@workspace/ui/components/button';
import { DialogDescription, DialogFooter } from '@workspace/ui/components/dialog';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import { useCallback, useContext } from 'react';
import type { DialogProps } from '../context/modal';
import { DialogPropsContext, ModalContext } from '../context/modal';

export function useDialog() {
    const { showModal, showNonModal, hideModal } = useContext(ModalContext);

    // A message with OK, or a yes or no whose onOk runs on OK. The notice closes itself, so onOk only does the work.
    const showNotice = useCallback(
        (message: string, type: 'ok' | 'yesno' = 'ok', onOk?: () => void) =>
            showModal(
                <NoticeDialog type={type} onOk={onOk}>
                    {message}
                </NoticeDialog>,
            ),
        [showModal],
    );

    return { showDialog: showModal, showNotice, showNonModalDialog: showNonModal, hideDialog: hideModal };
}

// The open and close of the dialog in the slot, for its FormDialog to spread.
export function useDialogProps(): DialogProps {
    return useContext(DialogPropsContext);
}

function NoticeDialog({ type, onOk, children }: { type: 'ok' | 'yesno'; onOk?: () => void; children: string }) {
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
