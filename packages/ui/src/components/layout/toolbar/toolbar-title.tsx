import type { ReactNode } from 'react';

export function ToolbarTitle({ children }: { children: ReactNode }) {
    return <span className="text-sm text-foreground font-normal truncate">{children}</span>;
}
