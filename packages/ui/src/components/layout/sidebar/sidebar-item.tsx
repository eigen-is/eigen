// One row of a side list, such as an app's sidebar or the docs outline: an icon and a label that link to a route,
// open a URL or run a click. Condensed, it shows the icon alone. A route row looks selected while its page is open,
// whatever the page has selected, and following it closes the sidebar. Its hover and selected fills end in the
// wordmark's ket.

import { Link } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { Button } from '../../button';
import { useLayout } from '../app/layout-context';

const IDLE_TEXT_CLASS = 'text-muted-foreground';

export type SidebarItemProps = {
    icon: ReactNode;
    label?: string;
    to?: string;
    href?: string;
    params?: Record<string, string>;
    colorDot?: string;
    onClick?: (e: MouseEvent) => void;
    condensed?: boolean;
    className?: string;
    children?: ReactNode;
    exact?: boolean;
};

export function SidebarItem({
    icon,
    label,
    to,
    href,
    params,
    colorDot,
    onClick,
    condensed = false,
    className,
    children,
    exact = false,
}: SidebarItemProps) {
    const { setSidebarOpen } = useLayout();
    const baseStyles = cn(
        'flex items-center rounded-md px-2.5 py-1.5 text-sm font-normal select-none eigen-ket-end hover:bg-muted hover:text-foreground',
        // A Button centers its content. A list of labels reads better from the left edge, as links do.
        condensed ? 'justify-center' : 'justify-start gap-2.5 text-left',
        className,
    );

    const content = (
        <>
            {colorDot && <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: colorDot }} />}
            {icon}
            {!condensed && label && <span className="min-w-0 flex-1 truncate">{label}</span>}
            {children}
        </>
    );

    if (to) {
        return (
            <Link
                to={to}
                params={params}
                // A caller's onClick runs first and may call preventDefault to navigate its own way. The sidebar
                // closes here and not on navigation, because a tap on the page already open navigates nowhere.
                onClick={(e) => {
                    onClick?.(e);
                    setSidebarOpen(false);
                }}
                className={baseStyles}
                // The router appends these to className and does not merge them. So the idle text color goes in
                // only on a row that is not selected.
                activeProps={{ className: 'bg-primary/10 text-primary' }}
                inactiveProps={{ className: IDLE_TEXT_CLASS }}
                // A row names a page, and the search holds what is selected on it, such as `?pid=`. So only the
                // path decides: an `exact` row at `/` stays selected when a click in its list adds a search.
                activeOptions={{ exact, includeSearch: false }}
            >
                {content}
            </Link>
        );
    }

    if (href) {
        return (
            <a href={href} className={cn(IDLE_TEXT_CLASS, baseStyles)}>
                {content}
            </a>
        );
    }

    return (
        <Button variant="ghost" className={cn(IDLE_TEXT_CLASS, baseStyles)} onClick={onClick}>
            {content}
        </Button>
    );
}
