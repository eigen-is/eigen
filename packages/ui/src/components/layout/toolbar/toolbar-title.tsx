import type { ReactNode } from 'react';

export function ToolbarTitle({ children }: { children: ReactNode }) {
    return <span className="text-sm text-foreground font-semibold truncate">{children}</span>;
}
