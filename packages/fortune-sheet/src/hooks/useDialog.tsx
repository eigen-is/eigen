import React, {useCallback, useContext} from "react";
import {Button} from "@workspace/ui/components/button";
import {DialogDescription, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {ModalContext} from "../context/modal";

export function useDialog() {
    const {showModal, hideModal} = useContext(ModalContext);

    const showDialog = useCallback(
        (
            content: string | React.ReactNode,
            type?: "ok" | "yesno",
            onOk: () => void = hideModal,
            onCancel: () => void = hideModal
        ) => {
            if (type) {
                showModal(
                    <DialogWrapper type={type} onOk={onOk} onCancel={onCancel}>
                        {content}
                    </DialogWrapper>
                );
            } else {
                showModal(content);
            }
        },
        [hideModal, showModal]
    );

    return {showDialog, hideDialog: hideModal};
}

function DialogWrapper({
                           type,
                           onOk,
                           onCancel,
                           children,
                       }: {
    type: "ok" | "yesno";
    onOk?: () => void;
    onCancel?: () => void;
    children?: React.ReactNode;
}) {
    return (
        <>
            <DialogHeader>
                <DialogTitle className="text-base">Notice</DialogTitle>
            </DialogHeader>
            <DialogDescription className="text-foreground">
                {children}
            </DialogDescription>
            <DialogFooter>
                {type === "yesno" && (
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
