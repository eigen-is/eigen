// The phone push for a page whose main must survive an open detail, such as an editor beside its comments or the
// calendar's grid beside an event. On a phone the open detail fills the screen while the main stays mounted, hidden
// with a class, so an editor keeps its document. On a desktop it shows the main alone, and the host puts the detail
// in its own right slot.

import type { ReactNode } from 'react';
import { useLayout } from './layout-context';

type PhoneDetailProps = {
    detail: ReactNode;
    children: ReactNode;
};

export function PhoneDetail({ detail, children }: PhoneDetailProps) {
    const { isMobile } = useLayout();
    const covered = isMobile && !!detail;
    // One wrapper open or closed, only its class toggles, so the main never remounts; contents leaves the host's layout
    // as it would be without it.
    return (
        <>
            <div className={covered ? 'hidden' : 'contents'}>{children}</div>
            {isMobile && detail}
        </>
    );
}
