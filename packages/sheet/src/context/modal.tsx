// The sheet's one dialog slot, which useDialog opens and closes. A dialog in it draws its own FormDialog and takes its
// open and close from the slot's DialogPropsContext, and the focus goes back to the grid when it closes. The range
// picker is the one exception: it leaves the grid usable to pick on and can open at a point on screen, so the slot
// draws a shell around it. Either way the slot keeps a dialog's mouse events from the React handlers above it.

import { Dialog, DialogContent } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useCellEditorRefocus } from '../hooks/useCellEditorRefocus';
import type { ViewportPoint } from '../state';

// The range picker's shell. It draws no backdrop, and a click on the grid picks a range instead of closing it.
type NonModalOptions = {
    // The shell's width in pixels.
    width?: number;
    // The point on screen where the shell's top-left corner opens, kept on screen. Centered when absent.
    anchor?: ViewportPoint;
    // Runs once when the picker leaves the slot, so a caller that holds state for the open picker, such as the flag
    // that keeps the cell editor out of the way, resets it in one place. The reason says how it left: 'closed' by
    // Cancel or Escape, or 'replaced' by another dialog, such as a notice or the dialog the picker's OK opens again.
    // Only a close may open a dialog, because on 'replaced' the slot already holds the next one.
    onClose?: (reason: CloseReason) => void;
};

type CloseReason = 'replaced' | 'closed';

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
    onCloseAutoFocus: (event: Event) => void;
};

export const DialogPropsContext = React.createContext<DialogProps>({
    open: false,
    onOpenChange: () => {},
    onCloseAutoFocus: () => {},
});

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
    const lastId = useRef(0);

    // A ref, not `state`: hideModal must stay identity-stable for its consumers, and it has to see the opening that
    // holds the slot right now.
    const openingRef = useRef<{ id: number; onClose?: NonModalOptions['onClose'] } | null>(null);

    const open = useCallback((content: React.ReactNode, nonModal?: NonModalOptions) => {
        const replaced = openingRef.current;
        lastId.current += 1;
        const id = lastId.current;
        openingRef.current = { id, onClose: nonModal?.onClose };
        setState({ id, content, nonModal });
        replaced?.onClose?.('replaced');
    }, []);
    const showModal = useCallback((content: React.ReactNode) => open(content), [open]);
    const hideModal = useCallback(() => {
        const opening = openingRef.current;
        openingRef.current = null;
        setState(null);
        opening?.onClose?.('closed');
    }, []);

    const refocusGrid = useCellEditorRefocus();
    const openId = state?.id;
    const dialogProps = useMemo<DialogProps>(
        () => ({
            open: true,
            onOpenChange: (o) => {
                if (!o && openingRef.current?.id === openId) hideModal();
            },
            // Radix runs this a moment after the dialog is gone, so a dialog opened in its place, such as a confirm,
            // already has the focus and keeps it.
            onCloseAutoFocus: refocusGrid,
        }),
        [hideModal, openId, refocusGrid],
    );

    const providerValue = useMemo(() => ({ showModal, showNonModal: open, hideModal }), [hideModal, open, showModal]);

    return (
        <ModalContext.Provider value={providerValue}>
            {children}
            {state &&
                // Keyed by the opening, so each one mounts its fields fresh, even the same dialog opened twice. The
                // slot unmounts a closed dialog at once, so no empty shell lingers while it would fade out.
                (state.nonModal ? (
                    <NonModalShell key={state.id} options={state.nonModal} onClose={hideModal}>
                        {state.content}
                    </NonModalShell>
                ) : (
                    <div key={state.id} className="contents" {...STOP_MOUSE_EVENTS}>
                        <DialogPropsContext.Provider value={dialogProps}>{state.content}</DialogPropsContext.Provider>
                    </div>
                ))}
        </ModalContext.Provider>
    );
}

function NonModalShell({
    options: { width = DEFAULT_WIDTH, anchor },
    onClose,
    children,
}: {
    options: NonModalOptions;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const [placement, setPlacement] = useState<ViewportPoint>();
    // A ref callback, not an effect: Radix portals the content a render after the shell mounts, and the clamp needs
    // its rendered size. Setting the placement as it attaches corrects it before the browser paints.
    const measure = useCallback(
        (el: HTMLDivElement | null) => {
            if (!el || !anchor) return;
            setPlacement(
                clampToViewport(
                    anchor,
                    { width: el.offsetWidth, height: el.offsetHeight },
                    { width: window.innerWidth, height: window.innerHeight },
                ),
            );
        },
        [anchor],
    );
    const position = anchor && (placement ?? anchor);

    return (
        <Dialog
            open
            modal={false}
            onOpenChange={(o) => {
                if (!o) onClose();
            }}
        >
            <DialogContent
                ref={measure}
                aria-describedby={undefined}
                showCloseButton={false}
                // A press on the grid, and the focus that moves there with it, picks a range. Neither may close the
                // picker.
                onInteractOutside={(e) => e.preventDefault()}
                // An anchored picker drops DialogContent's centering translate. The left and top below place it
                // instead.
                className={cn(position && 'translate-x-0 translate-y-0')}
                style={{ width, ...(position && { left: position.left, top: position.top }) }}
                {...STOP_MOUSE_EVENTS}
            >
                {children}
            </DialogContent>
        </Dialog>
    );
}

export { ModalContext, ModalProvider };
