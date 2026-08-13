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
    isActive?: boolean;
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
    isActive,
    colorDot,
    onClick,
    condensed = false,
    className,
    children,
    exact = false,
}: SidebarItemProps) {
    const { setSidebarOpen } = useLayout();
    const baseStyles = cn(
        'flex items-center rounded-md px-2.5 py-1.5 text-sm font-normal select-none',
        condensed ? 'justify-center' : 'gap-2.5',
        isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
                activeProps={{
                    className: 'bg-primary/10 text-primary',
                }}
                inactiveProps={{
                    className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                }}
                activeOptions={{ exact }}
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
