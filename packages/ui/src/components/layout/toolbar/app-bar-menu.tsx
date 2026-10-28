// One menu of an app's bar, such as Insert, Format or Filter: a trigger with its label and the menu's rows below it.
// It sits in a Menubar, which the bar renders around its menus, so the menus open, switch and close as one bar.
// FileMenu and EditMenu are built on it; each app passes its own rows and, for an editor, the handler that hands
// focus back to the editor as the menu closes.

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { MenubarContent, MenubarMenu, MenubarTrigger } from '../../menubar';

type AppBarMenuProps = {
    label: string;
    // The menu's name in the bar, for a bar that opens or closes it itself, as Stickies' Filter.
    value?: string;
    // Classes for the menu content, such as its width.
    contentClassName?: string;
    onCloseAutoFocus?: (event: Event) => void;
    children: ReactNode;
};

export function AppBarMenu({ label, value, contentClassName, onCloseAutoFocus, children }: AppBarMenuProps) {
    // While another menu of the bar is open, Radix opens this one as the pointer moves onto its trigger, before the
    // press the user aimed at it. That press must not close the menu again, as a press on an open trigger does.
    const openedByHoverRef = useRef(false);
    const keepOpenPressRef = useRef<PointerEvent | null>(null);
    return (
        <MenubarMenu value={value}>
            <MenubarTrigger
                onPointerEnter={(event) => {
                    if (event.currentTarget.dataset.state === 'open') return;
                    const bar = event.currentTarget.closest('[role="menubar"]');
                    openedByHoverRef.current = !!bar?.querySelector('[data-state="open"]');
                }}
                // A pointer that leaves without a press opened nothing a later press aims at.
                onPointerLeave={() => {
                    openedByHoverRef.current = false;
                }}
                onPointerDown={(event) => {
                    if (
                        event.button === 0 &&
                        event.currentTarget.dataset.state === 'open' &&
                        openedByHoverRef.current
                    ) {
                        keepOpenPressRef.current = event.nativeEvent;
                        // The open menu keeps the focus, as after a press that opened it, so the arrow keys work in it.
                        event.preventDefault();
                    }
                    openedByHoverRef.current = false;
                }}
            >
                {label}
            </MenubarTrigger>
            <MenubarContent
                className={contentClassName}
                onCloseAutoFocus={onCloseAutoFocus}
                onPointerDownOutside={(event) => {
                    if (event.detail.originalEvent === keepOpenPressRef.current) event.preventDefault();
                }}
            >
                {children}
            </MenubarContent>
        </MenubarMenu>
    );
}
