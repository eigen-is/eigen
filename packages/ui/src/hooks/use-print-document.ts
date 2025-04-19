import {useEffect} from "react";
import {printDocument} from "../lib/printElement";

export function usePrintDocument() {
    useEffect(() => {
        const onKeydown = (event: KeyboardEvent) => {
            const {key, ctrlKey, metaKey} = event;
            if ((metaKey || ctrlKey) && key === 'p') {
                printDocument();
                event.preventDefault();
            }
        }
        document.addEventListener('keydown', onKeydown);
        return () => document.removeEventListener('keydown', onKeydown);
    }, []);
}
