// The sheet's one dialog slot, which useDialog opens and closes. A dialog in it draws its own FormDialog and takes its
// open and close from the slot's DialogPropsContext. The range picker is the one exception: it leaves the grid usable
// to pick on and can open at a point on screen, so the slot draws a shell around it. Either way the slot keeps a
// dialog's mouse events from the React handlers above it.

import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ViewportPoint } from '../state';

// The range picker's shell. It draws no backdrop, and a click on the grid picks a range instead of closing it.
type NonModalOptions = {
    // The shell's width in pixels.
    width?: number;
    // The point on screen where the shell's top-left corner opens, kept on screen. Centered when absent.
    anchor?: ViewportPoint;
    // Runs once on every way the picker closes, such as Cancel or Escape, so a caller that holds state for the open
    // picker, like the grid-select flag, resets it in one place. Opening another dialog in the slot drops it unrun.
    // Data verification's picker commits the picked range and opens its own dialog again, and a late onClose would
    // run the teardown a second time over the dialog it just opened.
    onClose?: () => void;
};

const DEFAULT_WIDTH = 500;

// Distance a clamped dialog keeps from the viewport edges.
export const VIEWPORT_MARGIN = 8;

// Shifts a dialog of this size back on screen. Math.max runs last, so a dialog larger than the viewport pins to the
// top-left margin rather than off the opposite edge.
export function clampToViewport(
    point: ViewportPoint,
    size: { width: number; height: number },
    viewport: { width: number; height: number },
    margin: number = VIEWPORT_MARGIN,
): ViewportPoint {
    return {
        left: Math.max(margin, Math.min(point.left, viewport.width - size.width - margin)),
        top: Math.max(margin, Math.min(point.top, viewport.height - size.height - margin)),
    };
}

type ModalState = {
    // A new number for each opening, so a close from an opening the slot no longer holds is ignored.
    id: number;
    content: React.ReactNode;
    // Set for the range picker, which gets the shell.
    nonModal?: NonModalOptions;
};

// What a FormDialog in the slot spreads on itself. Its close does nothing once another dialog holds the slot, so a
// submit that opened a confirm doesn't close the confirm as it finishes.
export type DialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

export const DialogPropsContext = React.createContext<DialogProps>({ open: false, onOpenChange: () => {} });

// React passes a portaled dialog's mouse events up the component tree, past the slot to the handlers of the
// workbook's ancestors, so the slot stops them. Native listeners on the document still hear them.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const STOP_MOUSE_EVENTS = { onMouseDown: stop, onMouseMove: stop, onMouseUp: stop, onContextMenu: stop };

type ModalContextType = {
    showModal: (content: React.ReactNode) => void;
    showNonModal: (content: React.ReactNode, options: NonModalOptions) => void;
    hideModal: () => void;
};

const ModalContext = React.createContext<ModalContextType>({
    showModal: () => {},
    showNonModal: () => {},
    hideModal: () => {},
});

function ModalProvider({ children }: { children?: React.ReactNode }) {
    const [state, setState] = useState<ModalState | null>(null);
    const [placement, setPlacement] = useState<ViewportPoint | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const lastId = useRef(0);
    const anchor = state?.nonModal?.anchor;

    // A ref, not `state`: hideModal must stay identity-stable for its consumers, and it has to see the opening that
    // holds the slot right now.
    const openingRef = useRef<{ id: number; onClose?: () => void } | null>(null);

    const open = useCallback((content: React.ReactNode, nonModal?: NonModalOptions) => {
        lastId.current += 1;
        const id = lastId.current;
        openingRef.current = { id, onClose: nonModal?.onClose };
        setState({ id, content, nonModal });
    }, []);
    const showModal = useCallback((content: React.ReactNode) => open(content), [open]);
    const hideModal = useCallback(() => {
        const opening = openingRef.current;
        openingRef.current = null;
        setState(null);
        opening?.onClose?.();
    }, []);

    const openId = state?.id;
    const dialogProps = useMemo<DialogProps>(
        () => ({
            open: true,
            onOpenChange: (o) => {
                if (!o && openingRef.current?.id === openId) hideModal();
            },
        }),
        [hideModal, openId],
    );

    // useLayoutEffect, not useEffect: the clamp needs the picker's rendered height, so it
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

    const providerValue = useMemo(() => ({ showModal, showNonModal: open, hideModal }), [hideModal, open, showModal]);
    const position = anchor && (placement ?? anchor);

    return (
        <ModalContext.Provider value={providerValue}>
            {children}
            {state && !state.nonModal ? (
                // Keyed by the opening, so each one mounts its fields fresh, even the same dialog opened twice.
                <div key={state.id} className="contents" {...STOP_MOUSE_EVENTS}>
                    <DialogPropsContext.Provider value={dialogProps}>{state.content}</DialogPropsContext.Provider>
                </div>
            ) : (
                <Dialog
                    open={state !== null}
                    modal={false}
                    onOpenChange={(o) => {
                        if (!o) hideModal();
                    }}
                >
                    <DialogContent
                        ref={contentRef}
                        aria-describedby={undefined}
                        showCloseButton={false}
                        // A press on the grid, and the focus that moves there with it, picks a range. Neither may
                        // close the picker.
                        onInteractOutside={(e) => e.preventDefault()}
                        // An anchored picker drops DialogContent's centering translate. The left and top below
                        // place it instead.
                        className={cn(position && 'translate-x-0 translate-y-0')}
                        style={{
                            width: state?.nonModal?.width ?? DEFAULT_WIDTH,
                            ...(position && { left: position.left, top: position.top }),
                        }}
                        {...STOP_MOUSE_EVENTS}
                    >
                        {state?.content}
                    </DialogContent>
                </Dialog>
            )}
        </ModalContext.Provider>
    );
}

export { ModalContext, ModalProvider };
