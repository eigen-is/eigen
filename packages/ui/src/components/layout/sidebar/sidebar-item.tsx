import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { Button } from '../../button';

export type SidebarItemProps = {
    icon: ReactNode;
    label?: string;
    to?: string;
    href?: string;
    params?: Record<string, string>;
    isActive?: boolean;
    colorDot?: string;
    onClick?: () => void;
    condensed?: boolean;
    className?: string;
    children?: ReactNode;
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
}: SidebarItemProps) {
    const baseStyles = cn(
        'flex items-center rounded-md px-2.5 py-1.5 text-sm font-medium select-none',
        condensed ? 'justify-center' : 'gap-2.5',
        isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
    );

    const content = (
        <>
            {colorDot && <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colorDot }} />}
            {icon}
            {!condensed && label && <span>{label}</span>}
            {children}
        </>
    );

    if (to) {
        return (
            <Link
                to={to}
                params={params}
                className={baseStyles}
                activeProps={{
                    className: 'bg-primary/10 text-primary',
                }}
                inactiveProps={{
                    className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
                }}
                activeOptions={{ exact: false }}
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
