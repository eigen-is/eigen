import { Button } from '@workspace/ui/components/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import type React from 'react';
import { useCallback, useContext } from 'react';
import { ModalContext, type ModalOptions } from '../context/modal';

export function useDialog() {
    const { showModal, hideModal } = useContext(ModalContext);

    const showDialog = useCallback(
        (
            content: string | React.ReactNode,
            type?: 'ok' | 'yesno',
            onOk: () => void = hideModal,
            onCancel: () => void = hideModal,
        ) => {
            if (type) {
                showModal(
                    <DialogWrapper type={type} onOk={onOk} onCancel={onCancel}>
                        {content}
                    </DialogWrapper>,
                );
            } else {
                showModal(content);
            }
        },
        [hideModal, showModal],
    );

    /** Show a dialog without a modal backdrop — the rest of the page stays interactive. */
    const showNonModalDialog = useCallback(
        (content: React.ReactNode, options: Omit<ModalOptions, 'modal'> = {}) => {
            showModal(content, { ...options, modal: false });
        },
        [showModal],
    );

    return { showDialog, showNonModalDialog, hideDialog: hideModal };
}

function DialogWrapper({
    type,
    onOk,
    onCancel,
    children,
}: {
    type: 'ok' | 'yesno';
    onOk?: () => void;
    onCancel?: () => void;
    children?: React.ReactNode;
}) {
    return (
        <>
            <DialogHeader>
                <DialogTitle className="text-base">Notice</DialogTitle>
            </DialogHeader>
            <DialogDescription className="text-foreground">{children}</DialogDescription>
            <DialogFooter>
                {type === 'yesno' && (
                    <Button variant="outline" size="sm" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button size="sm" onClick={onOk}>
                    OK
                </Button>
            </DialogFooter>
        </>
    );
}
