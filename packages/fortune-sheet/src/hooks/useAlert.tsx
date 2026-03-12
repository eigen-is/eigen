import {useCallback} from "react";
import {useDialog} from "./useDialog";

export function useAlert() {
    const {showDialog, hideDialog} = useDialog();

    const showAlert = useCallback(
        (
            message: string,
            type: "ok" | "yesno" = "ok",
            onOk: () => void = hideDialog,
            onCancel: () => void = hideDialog
        ) => {
            showDialog(message, type, onOk, onCancel);
        },
        [hideDialog, showDialog]
    );

    return {showAlert, hideAlert: hideDialog};
}
