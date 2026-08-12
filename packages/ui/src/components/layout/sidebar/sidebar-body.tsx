import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type SidebarBodyProps = {
    children: ReactNode;
    className?: string;
};

// Sidebar content column. The full-height flex column every app sidebar needs
// (so `mt-auto` on StorageUsage sinks to the bottom) plus the content gutter
// (`app-gutter`), so apps stop hand-rolling the outer `flex h-full flex-col`
// wrapper and their sections never manage their own horizontal padding.
export function SidebarBody({ children, className }: SidebarBodyProps) {
    return <div className={cn('flex h-full flex-col app-gutter', className)}>{children}</div>;
}
