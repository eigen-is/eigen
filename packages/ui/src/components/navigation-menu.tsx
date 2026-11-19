// shadcn's NavigationMenu on Radix, without its viewport: a menu of links, such as the app switcher, that opens as the
// mouse rests on its trigger and closes as the mouse leaves it and its panel. Unlike a DropdownMenu it leaves the focus
// where it was while the mouse opens it, so an editor keeps the keys. A click, a tap or the keyboard opens it too.

import { cn } from '@workspace/ui/lib/utils';
import { NavigationMenu as NavigationMenuPrimitive } from 'radix-ui';
import type * as React from 'react';

function NavigationMenu({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Root>) {
    return (
        <NavigationMenuPrimitive.Root data-slot="navigation-menu" className={cn('relative', className)} {...props} />
    );
}

function NavigationMenuList({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.List>) {
    return (
        <NavigationMenuPrimitive.List
            data-slot="navigation-menu-list"
            className={cn('flex list-none items-center', className)}
            {...props}
        />
    );
}

function NavigationMenuItem({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Item>) {
    return (
        <NavigationMenuPrimitive.Item
            data-slot="navigation-menu-item"
            className={cn('relative', className)}
            {...props}
        />
    );
}

// Radix toggles on every click, so the press aimed at a trigger the resting mouse just opened would close it again. A
// mouse closes the menu by leaving it instead, and a tap or a key still toggles.
function NavigationMenuTrigger({ onClick, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Trigger>) {
    return (
        <NavigationMenuPrimitive.Trigger
            data-slot="navigation-menu-trigger"
            onClick={(event) => {
                onClick?.(event);
                const { nativeEvent } = event;
                const isMouse = nativeEvent instanceof PointerEvent && nativeEvent.pointerType === 'mouse';
                if (isMouse && event.currentTarget.dataset.state === 'open') event.preventDefault();
            }}
            {...props}
        />
    );
}

function NavigationMenuContent({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Content>) {
    return (
        <NavigationMenuPrimitive.Content
            data-slot="navigation-menu-content"
            className={cn(
                'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 absolute top-full left-0 z-50 mt-1 w-max origin-top-left rounded-md border shadow-md',
                className,
            )}
            {...props}
        />
    );
}

function NavigationMenuLink({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Link>) {
    return (
        <NavigationMenuPrimitive.Link
            data-slot="navigation-menu-link"
            className={cn(
                "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex items-center gap-4 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            {...props}
        />
    );
}

export {
    NavigationMenu,
    NavigationMenuContent,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
    NavigationMenuTrigger,
};
