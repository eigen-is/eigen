// The sheet's notices, such as a refused paste or a sheet delete to confirm: a message with OK, or a yes or no whose
// onOk runs on OK. A notice closes itself, so onOk only does the work.

import { useCallback } from 'react';
import { useDialog } from './useDialog';

export function useAlert() {
    const { showDialog } = useDialog();

    const showAlert = useCallback(
        (message: string, type: 'ok' | 'yesno' = 'ok', onOk?: () => void) => showDialog(message, type, onOk),
        [showDialog],
    );

    return { showAlert };
}
