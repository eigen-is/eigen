// shadcn's Menubar on Radix: the row of menus, such as File, Edit and Format, at the left of an app's bar. One open menu
// leaves the page live, so one press, a hover or an arrow key moves to the next menu. The trigger keeps the bar's
// ghost-button size and fills while its menu is open. The rows come from the DropdownMenu file: MenubarContent hands
// them the Menubar's Radix parts, so the same rows serve every bar menu and every dropdown. The two checks at the end
// tell an editor or a canvas beside the bar what a closing menu, or a press that closes one, leaves to it.

import { MenuRows } from '@workspace/ui/components/dropdown-menu';
import { OPEN_MENU } from '@workspace/ui/hooks/use-dialog-open';
import { cn } from '@workspace/ui/lib/utils';
import { Menubar as MenubarPrimitive } from 'radix-ui';
import type * as React from 'react';

function Menubar({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Root>) {
    return <MenubarPrimitive.Root data-slot="menubar" className={cn('flex items-center', className)} {...props} />;
}

function MenubarMenu({ ...props }: React.ComponentProps<typeof MenubarPrimitive.Menu>) {
    return <MenubarPrimitive.Menu data-slot="menubar-menu" {...props} />;
}

// No focus ring: Radix focuses a trigger after a mouse pick too, so only a keyboard's focus fills it.
function MenubarTrigger({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
    return (
        <MenubarPrimitive.Trigger
            data-slot="menubar-trigger"
            className={cn(
                'inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground dark:hover:bg-accent/50',
                className,
            )}
            {...props}
        />
    );
}

function MenubarContent({
    className,
    align = 'start',
    sideOffset = 4,
    children,
    ...props
}: React.ComponentProps<typeof MenubarPrimitive.Content>) {
    return (
        <MenubarPrimitive.Portal>
            <MenubarPrimitive.Content
                data-slot="menubar-content"
                align={align}
                sideOffset={sideOffset}
                // No exit animation, as shadcn's: a menu kept on screen while it fades would see the focus move into
                // the next menu and close the whole bar.
                className={cn(
                    'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-menubar-content-available-height) min-w-[8rem] origin-(--radix-menubar-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
                    className,
                )}
                {...props}
            >
                <MenuRows parts={MenubarPrimitive}>{children}</MenuRows>
            </MenubarPrimitive.Content>
        </MenubarPrimitive.Portal>
    );
}

// Whether a closing menu leaves the focus for the editor to take back: on the page's body, where a pick or Esc leaves it
// as the menu unmounts, or on a menu's trigger. A press outside the open menu focuses what it lands on, such as an
// input, and the next menu or a dialog a pick opened takes the focus too; those keep it.
export function focusLeftToEditor(): boolean {
    const focused = document.activeElement;
    return !focused || focused === document.body || focused.matches('[aria-haspopup="menu"]');
}

// Whether a press lands while a menu is open, such as a bar menu, and so only closes it. The menu leaves the page live,
// so the press reaches what lies under it too, where an eraser or a text tool would act on it. A pointerdown handler
// asks this before Radix closes the menu on the same press.
export function pressClosesMenu(): boolean {
    return document.querySelector(OPEN_MENU) !== null;
}

export { Menubar, MenubarContent, MenubarMenu, MenubarTrigger };
