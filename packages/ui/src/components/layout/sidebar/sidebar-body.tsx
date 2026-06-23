import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type SidebarBodyProps = {
    children: ReactNode;
    className?: string;
};

// Sidebar content column. Owns the content gutter (`app-gutter`) so the
// SidebarSection / StorageUsage children inside it never manage their own
// horizontal padding — every app sidebar renders its sections into one of these.
export function SidebarBody({ children, className }: SidebarBodyProps) {
    return <div className={cn('flex flex-1 flex-col app-gutter', className)}>{children}</div>;
}
