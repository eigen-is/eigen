import type { ReactNode } from 'react';

export function Toolbar({ children }: { children: ReactNode }) {
    return <div className="flex items-center justify-between w-full gap-1 no-print">{children}</div>;
}

// Three-slot toolbar whose center sits at the bar's TRUE center, not in the gap
// between the (usually unequal) left and right blocks. The 1fr·auto·1fr grid's equal
// side columns pin the middle; the center stays a fixed slot so the columns hold even
// when it's empty (e.g. a formatting block hidden on mobile/read-only).
export function CenteredToolbar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }) {
    return (
        <div className="grid items-center w-full gap-1 no-print" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
            <div className="flex items-center justify-start min-w-0">{left}</div>
            <div className="flex items-center justify-center min-w-0">{center}</div>
            <div className="flex items-center justify-end">{right}</div>
        </div>
    );
}
