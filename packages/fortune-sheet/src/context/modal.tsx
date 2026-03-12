import React, {useCallback, useMemo, useState} from "react";
import {Dialog, DialogContent,} from "@workspace/ui/components/dialog";

type ModalContextType = {
    showModal: (c: React.ReactNode) => void;
    hideModal: () => void;
};

const ModalContext = React.createContext<ModalContextType>({
    showModal: () => {
    },
    hideModal: () => {
    },
});

function ModalProvider({children}: { children?: React.ReactNode }) {
    const [content, setContent] = useState<React.ReactNode>(null);
    const open = content !== null;

    const showModal = useCallback((c: React.ReactNode) => setContent(c), []);
    const hideModal = useCallback(() => setContent(null), []);

    const providerValue = useMemo(
        () => ({showModal, hideModal}),
        [hideModal, showModal]
    );

    return (
        <ModalContext.Provider value={providerValue}>
            {children}
            <Dialog open={open} onOpenChange={(o) => {
                if (!o) hideModal();
            }}>
                <DialogContent
                    showCloseButton={false}
                    onPointerDownOutside={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    className="w-auto max-w-[90vw] max-h-[85vh] overflow-y-auto p-0"
                >
                    <div
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseMove={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                    >
                        {content}
                    </div>
                </DialogContent>
            </Dialog>
        </ModalContext.Provider>
    );
}

export {ModalContext, ModalProvider};
