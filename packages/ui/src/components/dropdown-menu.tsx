// shadcn's DropdownMenu on Radix, and the rows every menu in the app is built from, such as a kebab, a context menu or
// a bar menu. A row takes the Radix parts of the menu it sits in: a DropdownMenu's by default, the Menubar's inside a
// bar menu, which MenuRows provides. On a phone a submenu opens as a page of its menu, with a back row, instead of a
// panel beside it. ChoiceMenuSub and ChoiceMenuItems draw a choice as a submenu with a check on the current option.

import { useIsMobile } from '@workspace/lib/media';
import { cn } from '@workspace/ui/lib/utils';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, MinusIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
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

// Mobile drill-in state, provided by a DropdownMenu's root so it survives forceMount close, or by MenuRows inside a
// bar menu's content; null on desktop.
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
const ROOT_PAGE = { id: null };
const PageContext = createContext<{ id: string | null }>(ROOT_PAGE);

// A submenu's id and the label read from its trigger, which its trigger and its content share.
const SubContext = createContext<{ id: string; label: React.ReactNode } | null>(null);

// The Radix parts a row renders. Radix gives each kind of menu its own contexts, so a DropdownMenu row inside a Menubar
// menu would find no menu around it.
type MenuParts = Pick<
    typeof DropdownMenuPrimitive,
    | 'Group'
    | 'Item'
    | 'CheckboxItem'
    | 'RadioGroup'
    | 'RadioItem'
    | 'ItemIndicator'
    | 'Label'
    | 'Separator'
    | 'Sub'
    | 'SubTrigger'
    | 'SubContent'
>;
const MenuPartsContext = createContext<MenuParts>(DropdownMenuPrimitive);

const subTriggerClassName =
    "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-4 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-10 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

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

// The drill-in stack of one menu. reset() sends the next open back to the root page.
function useMobileMenu(): { value: MobileMenuState; reset: () => void } {
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
    const reset = () => {
        setStack((s) => (s.length ? [] : s));
        setFocusTarget(null);
    };
    return { value, reset };
}

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
    const isMobile = useIsMobile();
    const { value, reset } = useMobileMenu();

    // A controlled menu can close when its owner sets open to false, which fires no onOpenChange. A context
    // menu whose plain button rows call close() does that. Reset, so the next open starts at the root page.
    useEffect(() => {
        if (props.open === false) reset();
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
                    if (!open) reset();
                }}
            />
        </MobileMenuContext.Provider>
    );
}

// Hands the rows inside a menu's content the Radix parts of that menu, such as the Menubar's, with the drill-in stack a
// phone needs. The content unmounts as its menu closes, so the next open starts at the root page.
function MenuRows({ parts, children }: { parts: MenuParts; children: React.ReactNode }) {
    const isMobile = useIsMobile();
    const { value } = useMobileMenu();
    return (
        <MenuPartsContext.Provider value={parts}>
            <MobileMenuContext.Provider value={isMobile ? value : null}>{children}</MobileMenuContext.Provider>
        </MenuPartsContext.Provider>
    );
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
    return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
    return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

// Its rows take the DropdownMenu's parts and start on its root page, also where the menu sits inside another menu's rows,
// such as a picker in a bar menu.
function DropdownMenuContent({
    className,
    sideOffset = 4,
    children,
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
            >
                <MenuPartsContext.Provider value={DropdownMenuPrimitive}>
                    <PageContext.Provider value={ROOT_PAGE}>{children}</PageContext.Provider>
                </MenuPartsContext.Provider>
            </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
    );
}

function DropdownMenuGroup({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.Group
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
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.Item
            data-slot="dropdown-menu-item"
            data-inset={inset}
            data-variant={variant}
            className={cn(
                "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-4 rounded-sm px-2 py-1.5 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-10 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.CheckboxItem
            data-slot="dropdown-menu-checkbox-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-4 rounded-sm py-1.5 pr-2 pl-10 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
                hidden && 'hidden',
            )}
            checked={checked}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
                <Parts.ItemIndicator>
                    {checked === 'indeterminate' ? <MinusIcon className="size-4" /> : <CheckIcon className="size-4" />}
                </Parts.ItemIndicator>
            </span>
            {children}
        </Parts.CheckboxItem>
    );
}

function DropdownMenuRadioGroup({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.RadioGroup
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
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.RadioItem
            data-slot="dropdown-menu-radio-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-4 rounded-sm py-1.5 pr-2 pl-10 text-sm whitespace-nowrap outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
                hidden && 'hidden',
            )}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
                <Parts.ItemIndicator>
                    <CheckIcon className="size-4" />
                </Parts.ItemIndicator>
            </span>
            {children}
        </Parts.RadioItem>
    );
}

function DropdownMenuLabel({
    className,
    inset,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
}) {
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    return (
        <Parts.Label
            data-slot="dropdown-menu-label"
            data-inset={inset}
            className={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-10', className, hidden && 'hidden')}
            {...props}
        />
    );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
    const Parts = useContext(MenuPartsContext);
    const hidden = useRowHidden();
    // Hides itself when it opens the menu, follows another separator or has no row after it, so a group whose rows
    // all render nothing leaves no line behind.
    return (
        <Parts.Separator
            data-slot="dropdown-menu-separator"
            className={cn(
                'bg-border -mx-1 my-1 h-px first:hidden [[data-slot=dropdown-menu-separator]+&]:hidden [&:not(:has(~:not([data-slot=dropdown-menu-separator])))]:hidden',
                className,
                hidden && 'hidden',
            )}
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
    const Parts = useContext(MenuPartsContext);
    const menu = useContext(MobileMenuContext);
    const id = useId();
    const value = useMemo(() => (menu ? { id, label: subTriggerLabel(children) } : null), [menu, id, children]);

    if (!menu) {
        return (
            <Parts.Sub data-slot="dropdown-menu-sub" {...props}>
                {children}
            </Parts.Sub>
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
    const Parts = useContext(MenuPartsContext);
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
            <Parts.Item
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
            </Parts.Item>
        );
    }

    return (
        <Parts.SubTrigger
            data-slot="dropdown-menu-sub-trigger"
            data-inset={inset}
            className={cn(subTriggerClassName, className)}
            {...props}
        >
            {children}
            <ChevronRightIcon className="ml-auto size-4" />
        </Parts.SubTrigger>
    );
}

function DropdownMenuSubContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
    const Parts = useContext(MenuPartsContext);
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
        // Page children mount only once pushed onto the stack — desktop SubContent is
        // equally lazy (Presence), and heavy pages (color grids) would otherwise mount
        // hidden on every menu open. Popped pages unmount and drop their local state.
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
                    {menu.stack.includes(sub.id) && children}
                </div>
            </PageContext.Provider>
        );
    }

    return (
        <Parts.SubContent
            data-slot="dropdown-menu-sub-content"
            className={cn(
                'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg',
                className,
            )}
            {...props}
        >
            {children}
        </Parts.SubContent>
    );
}

// One option of a choice: the value it sets and its row, which an icon, swatch or avatar may lead.
type ChoiceOption<T> = { value: T; label: React.ReactNode };

type ChoiceMenuItemsProps<T extends string | number | boolean | null> = {
    // The current value; undefined, as for a mixed selection, checks no row.
    value: T | undefined;
    options: readonly ChoiceOption<T>[];
    onChange: (value: T) => void;
};

// docs/LAYOUT.md § A choice is a submenu with a check: one row per option, the current one checked.
function ChoiceMenuItems<T extends string | number | boolean | null>({
    value,
    options,
    onChange,
}: ChoiceMenuItemsProps<T>) {
    return (
        <DropdownMenuRadioGroup value={value === undefined ? '' : String(value)}>
            {options.map((option) => (
                <DropdownMenuRadioItem
                    key={String(option.value)}
                    value={String(option.value)}
                    onSelect={() => onChange(option.value)}
                >
                    {option.label}
                </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
    );
}

type ChoiceMenuSubProps<T extends string | number | boolean | null> = ChoiceMenuItemsProps<T> & {
    // The submenu's row: the property's icon and name.
    trigger: React.ReactNode;
    disabled?: boolean;
    contentClassName?: string;
};

// A choice in a menu of actions: a submenu named for the property, its options in ChoiceMenuItems.
function ChoiceMenuSub<T extends string | number | boolean | null>({
    trigger,
    disabled,
    contentClassName,
    ...choice
}: ChoiceMenuSubProps<T>) {
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={disabled}>{trigger}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={contentClassName}>
                <ChoiceMenuItems {...choice} />
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}

export {
    ChoiceMenuItems,
    ChoiceMenuSub,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuPortal,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    MenuRows,
};
