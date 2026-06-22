import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type SidebarSectionProps = {
    title?: string;
    /** Trailing element next to the title (e.g. an inline action button). In condensed mode
     *  the title is hidden and the action sits centered on its own. */
    action?: ReactNode;
    children: ReactNode;
    condensed?: boolean;
    className?: string;
};

export function SidebarSection({ title, action, children, condensed = false, className }: SidebarSectionProps) {
    const showHeader = title || action;
    return (
        <div className={cn('px-3 pt-3 pb-1', className)}>
            {showHeader && (
                <div
                    className={cn('flex items-center mb-1.5 px-2.5', condensed ? 'justify-center' : 'justify-between')}
                >
                    {!condensed && title && <h3 className="eigen-section-label">{title}</h3>}
                    {condensed && title && !action && <span className="eigen-section-label">{title[0]}</span>}
                    {action}
                </div>
            )}
            <div className="space-y-0.5">{children}</div>
        </div>
    );
}
