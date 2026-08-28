import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import React, { useCallback, useMemo, useState } from 'react';

export type ModalOptions = {
    // When false, no backdrop and the rest of the page stays interactive (e.g. range picker).
    modal?: boolean;
};

type ModalState = {
    content: React.ReactNode;
    options: ModalOptions;
};

type ModalContextType = {
    showModal: (c: React.ReactNode, options?: ModalOptions) => void;
    hideModal: () => void;
};

const ModalContext = React.createContext<ModalContextType>({
    showModal: () => {},
    hideModal: () => {},
});

function ModalProvider({ children }: { children?: React.ReactNode }) {
    const [state, setState] = useState<ModalState | null>(null);
    const open = state !== null;
    const isModal = state?.options.modal !== false;

    const showModal = useCallback((c: React.ReactNode, options: ModalOptions = {}) => {
        setState({ content: c, options });
    }, []);
    const hideModal = useCallback(() => setState(null), []);

    const providerValue = useMemo(() => ({ showModal, hideModal }), [hideModal, showModal]);

    return (
        <ModalContext.Provider value={providerValue}>
            {children}
            <Dialog
                open={open}
                modal={isModal}
                onOpenChange={(o) => {
                    if (!o) hideModal();
                }}
            >
                <DialogContent
                    showCloseButton={false}
                    onPointerDownOutside={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    className="max-w-[90vw]"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        maxHeight: '75vh',
                        overflow: 'hidden',
                        width: 500,
                    }}
                >
                    <div
                        // gap-4 reproduces DialogContent's own rhythm: the inline display:flex above
                        // overrides its grid, and this wrapper is the real parent of header/body/footer.
                        className="flex flex-col gap-4 min-h-0 flex-1"
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseMove={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                    >
                        {state?.content}
                    </div>
                </DialogContent>
            </Dialog>
        </ModalContext.Provider>
    );
}

export { ModalContext, ModalProvider };
