import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function ToolbarTitle({ children, className }: { children: ReactNode; className?: string }) {
    return <span className={cn('eigen-toolbar-title', className)}>{children}</span>;
}
