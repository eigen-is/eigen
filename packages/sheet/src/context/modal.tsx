import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clampToViewport, type ViewportPoint } from '../state';

export type ModalOptions = {
    // When false, no backdrop and the rest of the page stays interactive (e.g. range picker).
    modal?: boolean;
    // Dialog width in px — forms want the default, a small picker overrides it.
    width?: number;
    // Viewport point the dialog's top-left opens at, clamped on screen. Centred when absent.
    anchor?: ViewportPoint;
    // Runs on every close route — a Cancel button, Escape, anything Radix adds later — so
    // callers holding state for an open dialog (the range picker's grid-select flag) can
    // reset it from one place. Replacing the content via showModal drops it unrun: the
    // caller that replaced it is already in control.
    onClose?: () => void;
};

const DEFAULT_WIDTH = 500;

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
    const [placement, setPlacement] = useState<ViewportPoint | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const open = state !== null;
    const isModal = state?.options.modal !== false;
    const anchor = state?.options.anchor;

    // A ref, not `state`: hideModal must stay identity-stable for its consumers, and it
    // has to see the options of whatever is open right now.
    const onCloseRef = useRef<ModalOptions['onClose']>(undefined);

    const showModal = useCallback((c: React.ReactNode, options: ModalOptions = {}) => {
        onCloseRef.current = options.onClose;
        setState({ content: c, options });
    }, []);
    const hideModal = useCallback(() => {
        const { current: onClose } = onCloseRef;
        onCloseRef.current = undefined;
        setState(null);
        onClose?.();
    }, []);

    // useLayoutEffect, not useEffect: the clamp needs the dialog's rendered height, so it
    // renders once at the raw anchor and is corrected before the browser paints either frame.
    useLayoutEffect(() => {
        const el = contentRef.current;
        if (!anchor || !el) {
            setPlacement(null);
            return;
        }
        setPlacement(
            clampToViewport(
                anchor,
                { width: el.offsetWidth, height: el.offsetHeight },
                { width: window.innerWidth, height: window.innerHeight },
            ),
        );
    }, [anchor]);

    const providerValue = useMemo(() => ({ showModal, hideModal }), [hideModal, showModal]);
    const position = anchor && (placement ?? anchor);

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
                    ref={contentRef}
                    showCloseButton={false}
                    onPointerDownOutside={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    // An anchored dialog drops DialogContent's centring translate; the pair of
                    // left/top below places it instead.
                    className={cn('max-w-[90vw]', position && 'translate-x-0 translate-y-0')}
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        maxHeight: '75vh',
                        overflow: 'hidden',
                        width: state?.options.width ?? DEFAULT_WIDTH,
                        ...(position && { left: position.left, top: position.top }),
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
