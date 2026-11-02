// One row of a side list, such as an app's sidebar or the docs outline: an icon and a label that link to a route,
// open a URL or run a click. Condensed, it shows the icon alone. A route row looks selected while its page is open,
// whatever the page has selected, and following it closes the sidebar. Its hover and selected fills end in the
// wordmark's ket (.eigen-ket-end in globals.css).

import { Link } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { Button } from '../../button';
import { useLayout } from '../app/layout-context';

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
        'flex items-center rounded-md px-2.5 py-1.5 text-sm font-normal select-none eigen-ket-end',
        // A Button centers its content. A list of labels reads better from the left edge, as links do.
        condensed ? 'justify-center' : 'justify-start gap-2.5 text-left',
        'text-muted-foreground hover:bg-muted hover:text-foreground',
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
                // Forward the click first (a caller can preventDefault here to run its own
                // navigation), then close: a tap on the already-current route is a router no-op.
                onClick={(e) => {
                    onClick?.(e);
                    setSidebarOpen(false);
                }}
                className={baseStyles}
                activeProps={{ className: 'bg-primary/10 text-primary' }}
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
            <a href={href} className={baseStyles}>
                {content}
            </a>
        );
    }

    return (
        <Button variant="ghost" className={baseStyles} onClick={onClick}>
            {content}
        </Button>
    );
}
