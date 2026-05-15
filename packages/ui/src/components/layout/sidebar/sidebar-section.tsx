import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type SidebarSectionProps = {
    title?: string;
    children: ReactNode;
    condensed?: boolean;
    className?: string;
};

export function SidebarSection({ title, children, condensed = false, className }: SidebarSectionProps) {
    return (
        <div className={cn('px-3 pt-3 pb-1', className)}>
            {title && (
                <div className={cn('flex items-center mb-1.5', condensed ? 'justify-center' : 'justify-between')}>
                    {!condensed && <h3 className="eigen-section-label">{title}</h3>}
                    {condensed && <span className="eigen-section-label">{title[0]}</span>}
                </div>
            )}
            <div className="space-y-0.5">{children}</div>
        </div>
    );
}
