import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { EigenLoader } from '../braket/eigen-loader';

export type SidebarSectionProps = {
    title?: string;
    action?: ReactNode;
    children?: ReactNode;
    condensed?: boolean;
    className?: string;
    // The one canonical sidebar-scale loader/error/empty treatment. When set, it
    // replaces the section body (the header stays); apps stop hand-rolling these.
    loading?: boolean;
    error?: string;
    empty?: string;
};

export function SidebarSection({
    title,
    action,
    children,
    condensed = false,
    className,
    loading = false,
    error,
    empty,
}: SidebarSectionProps) {
    const showHeader = title || action;
    return (
        <div className={cn('pt-3 pb-1', className)}>
            {showHeader && (
                <div
                    className={cn('flex items-center mb-1.5 px-2.5', condensed ? 'justify-center' : 'justify-between')}
                >
                    {!condensed && title && <h3 className="eigen-section-label">{title}</h3>}
                    {condensed && title && !action && <span className="eigen-section-label">{title[0]}</span>}
                    {action}
                </div>
            )}
            {loading ? (
                <div className="flex justify-center py-4">
                    <EigenLoader />
                </div>
            ) : error ? (
                <p className="px-2.5 py-2 text-sm text-center text-destructive">{error}</p>
            ) : empty ? (
                <p className="px-2.5 py-2 text-sm text-center text-muted-foreground">{empty}</p>
            ) : (
                <div className="space-y-0.5">{children}</div>
            )}
        </div>
    );
}
