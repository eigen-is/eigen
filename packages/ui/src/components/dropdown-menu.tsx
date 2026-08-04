import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { useIsMobile } from '@workspace/lib/media';
import { cn } from '@workspace/ui/lib/utils';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import type * as React from 'react';
import {
    Children,
    createContext,
    isValidElement,
    useContext,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react';

// After a drill-in transition, which row takes focus: the opened page's back row
// ('back', on push) or the sub-trigger a pop returned to ('trigger', on pop).
type FocusTarget = { id: string; role: 'back' | 'trigger' };

// Mobile drill-in state, provided by the root so it survives forceMount close; null on desktop.
type MobileMenuState = {
    stack: string[];
    activePage: string | null;
    push: (id: string) => void;
    pop: () => void;
    // The row to focus after the last push/pop; the matching row focuses itself then clears it,
    // so an external-keyboard / AT user isn't stranded on a now-hidden row.
    focusTarget: FocusTarget | null;
    clearFocus: () => void;
};
const MobileMenuContext = createContext<MobileMenuState | null>(null);

// The page a row sits on: null = root, otherwise the enclosing sub's id.
const PageContext = createContext<{ id: string | null }>({ id: null });

// A sub's id + the label lifted from its trigger, shared by its trigger and its content.
const SubContext = createContext<{ id: string; label: React.ReactNode } | null>(null);

const subTriggerClassName =
    "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// A row is hidden unless the active page matches the page it sits on.
function useRowHidden(): boolean {
    const menu = useContext(MobileMenuContext);
    const page = useContext(PageContext);
    return !!menu && page.id !== menu.activePage;
}

function subTriggerLabel(children: React.ReactNode): React.ReactNode {
    for (const child of Children.toArray(children)) {
        if (isValidElement(child) && child.type === DropdownMenuSubTrigger) {
            return (child.props as { children?: React.ReactNode }).children;
        }
    }
    return null;
}

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
    const isMobile = useIsMobile();
    const [stack, setStack] = useState<string[]>([]);
    const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
    const value = useMemo<MobileMenuState>(
        () => ({
            stack,
            activePage: stack.at(-1) ?? null,
            push: (id) => {
                setStack((s) => [...s, id]);
                setFocusTarget({ id, role: 'back' });
            },
            pop: () => {
                const popped = stack.at(-1);
                setStack((s) => s.slice(0, -1));
                if (popped) setFocusTarget({ id: popped, role: 'trigger' });
            },
            focusTarget,
            clearFocus: () => setFocusTarget(null),
        }),
        [stack, focusTarget],
    );

    // A controlled root can close via an external open→false flip that never fires onOpenChange
    // (e.g. context menus whose plain-button rows call close()); reset so the next open is root.
    useEffect(() => {
        if (props.open === false) {
            setStack((s) => (s.length ? [] : s));
            setFocusTarget(null);
        }
    }, [props.open]);

    if (!isMobile) {
        return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
    }

    return (
        <MobileMenuContext.Provider value={value}>
            <DropdownMenuPrimitive.Root
                data-slot="dropdown-menu"
                {...props}
                onOpenChange={(open) => {
                    props.onOpenChange?.(open);
                    // Reset on close so reopening lands on root (forceMount keeps Content mounted, so unmount can't).
                    if (!open) {
                        setStack([]);
                        setFocusTarget(null);
                    }
                }}
            />
        </MobileMenuContext.Provider>
    );
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
    return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
    return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
    className,
    sideOffset = 4,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
    return (
        <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
                data-slot="dropdown-menu-content"
                sideOffset={sideOffset}
                className={cn(
                    'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
                    className,
                )}
                {...props}
            />
        </DropdownMenuPrimitive.Portal>
    );
}

function DropdownMenuGroup({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.Group
            data-slot="dropdown-menu-group"
            className={cn(className, hidden && 'hidden') || undefined}
            {...props}
        />
    );
}

function DropdownMenuItem({
    className,
    inset,
    variant = 'default',
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
}) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.Item
            data-slot="dropdown-menu-item"
            data-inset={inset}
            data-variant={variant}
            className={cn(
                "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                props.onClick || props.asChild ? 'cursor-pointer' : 'cursor-default',
                className,
                hidden && 'hidden',
            )}
            {...props}
        />
    );
}

function DropdownMenuCheckboxItem({
    className,
    children,
    checked,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.CheckboxItem
            data-slot="dropdown-menu-checkbox-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
                hidden && 'hidden',
            )}
            checked={checked}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <DropdownMenuPrimitive.ItemIndicator>
                    <CheckIcon className="size-4" />
                </DropdownMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </DropdownMenuPrimitive.CheckboxItem>
    );
}

function DropdownMenuRadioGroup({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.RadioGroup
            data-slot="dropdown-menu-radio-group"
            className={cn(className, hidden && 'hidden') || undefined}
            {...props}
        />
    );
}

function DropdownMenuRadioItem({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.RadioItem
            data-slot="dropdown-menu-radio-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
                hidden && 'hidden',
            )}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <DropdownMenuPrimitive.ItemIndicator>
                    <CircleIcon className="size-2 fill-current" />
                </DropdownMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </DropdownMenuPrimitive.RadioItem>
    );
}

function DropdownMenuLabel({
    className,
    inset,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
}) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.Label
            data-slot="dropdown-menu-label"
            data-inset={inset}
            className={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className, hidden && 'hidden')}
            {...props}
        />
    );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
    const hidden = useRowHidden();
    return (
        <DropdownMenuPrimitive.Separator
            data-slot="dropdown-menu-separator"
            className={cn('bg-border -mx-1 my-1 h-px', className, hidden && 'hidden')}
            {...props}
        />
    );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
    return (
        <span
            data-slot="dropdown-menu-shortcut"
            className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
            {...props}
        />
    );
}

function DropdownMenuSub({ children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
    const menu = useContext(MobileMenuContext);
    const id = useId();
    const value = useMemo(() => (menu ? { id, label: subTriggerLabel(children) } : null), [menu, id, children]);

    if (!menu) {
        return (
            <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props}>
                {children}
            </DropdownMenuPrimitive.Sub>
        );
    }

    return <SubContext.Provider value={value}>{children}</SubContext.Provider>;
}

function DropdownMenuSubTrigger({
    className,
    inset,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
}) {
    const menu = useContext(MobileMenuContext);
    const sub = useContext(SubContext);
    const hidden = useRowHidden();
    const triggerRef = useRef<HTMLDivElement>(null);

    // A pop restores focus here, to the trigger that opened the page we just left.
    useEffect(() => {
        if (menu && sub && menu.focusTarget?.id === sub.id && menu.focusTarget.role === 'trigger') {
            triggerRef.current?.focus();
            menu.clearFocus();
        }
    }, [menu, sub]);

    if (menu && sub) {
        // A root-collection Item; opening a page must not close the menu, so preventDefault.
        return (
            <DropdownMenuPrimitive.Item
                {...props}
                ref={triggerRef}
                data-slot="dropdown-menu-sub-trigger"
                data-inset={inset}
                onSelect={(event) => {
                    event.preventDefault();
                    menu.push(sub.id);
                }}
                className={cn(subTriggerClassName, className, hidden && 'hidden')}
            >
                {children}
                <ChevronRightIcon className="ml-auto size-4" />
            </DropdownMenuPrimitive.Item>
        );
    }

    return (
        <DropdownMenuPrimitive.SubTrigger
            data-slot="dropdown-menu-sub-trigger"
            data-inset={inset}
            className={cn(subTriggerClassName, className)}
            {...props}
        >
            {children}
            <ChevronRightIcon className="ml-auto size-4" />
        </DropdownMenuPrimitive.SubTrigger>
    );
}

function DropdownMenuSubContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
    const menu = useContext(MobileMenuContext);
    const sub = useContext(SubContext);
    const pageValue = useMemo(() => ({ id: sub?.id ?? null }), [sub?.id]);
    const pageRef = useRef<HTMLDivElement>(null);

    // A push lands focus on this page's back row (the pushed sub-trigger itself just went hidden).
    useEffect(() => {
        if (menu && sub && menu.focusTarget?.id === sub.id && menu.focusTarget.role === 'back') {
            pageRef.current?.querySelector<HTMLElement>(':scope > [data-slot="dropdown-menu-sub-back"]')?.focus();
            menu.clearFocus();
        }
    }, [menu, sub]);

    if (menu && sub) {
        // contents keeps rows flat in the scrolling Content; none hides the whole page (incl. non-item JSX) off-path, while on-path ancestors stay contents so nested pages still show.
        // className/props are desktop-panel concerns, intentionally dropped: the page inherits the root Content's box + scroll.
        return (
            <PageContext.Provider value={pageValue}>
                <div
                    ref={pageRef}
                    data-slot="dropdown-menu-sub-page"
                    className={cn('contents', !menu.stack.includes(sub.id) && 'hidden')}
                >
                    <DropdownMenuItem
                        data-slot="dropdown-menu-sub-back"
                        className="cursor-pointer font-medium"
                        onSelect={(event) => {
                            event.preventDefault();
                            menu.pop();
                        }}
                    >
                        <ChevronLeftIcon />
                        {sub.label}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {children}
                </div>
            </PageContext.Provider>
        );
    }

    return (
        <DropdownMenuPrimitive.SubContent
            data-slot="dropdown-menu-sub-content"
            className={cn(
                'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg',
                className,
            )}
            {...props}
        >
            {children}
        </DropdownMenuPrimitive.SubContent>
    );
}

export {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuPortal,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
};
