// The app sidebar's frame beside the main: a small column on a desktop, a rail of icons on a tablet and, on a phone,
// a full-width column that replaces the main while it is open. AppShell renders it around the app's own sidebar,
// which it hands the condensed flag on a tablet.

import { useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { cn } from '../../../lib/utils';
import { columnWidthPx } from '../app/column-widths';
import { useLayout } from '../app/layout-context';

export type SidebarProps = {
    condensed: boolean;
};

type SidebarContainerProps = {
    sidebar: ReactNode | ((props: SidebarProps) => ReactNode);
};

export function SidebarContainer({ sidebar }: SidebarContainerProps) {
    const { sidebarOpen, setSidebarOpen, sidebarColumnShown, sidebarMode, isMobile, isTablet } = useLayout();
    // The href, not the pathname, so a navigation that changes only the search, such as Mail's ?mode=compose, also
    // closes the phone's sidebar.
    const { href } = useLocation();

    useEffect(() => {
        if (isMobile && sidebarOpen) setSidebarOpen(false);
    }, [href]);

    if (sidebarMode === 'none') return null;

    const sidebarContent = typeof sidebar === 'function' ? sidebar({ condensed: isTablet }) : sidebar;

    return (
        <div
            className={cn(
                // The w-16 rail is the 40px primary button plus the sidebar gutter on each side.
                'h-full overflow-y-auto overflow-x-hidden',
                !isMobile && 'app-gutter-sidebar',
                isMobile ? (sidebarColumnShown ? 'block w-full' : 'hidden') : isTablet ? 'block w-16' : 'block',
            )}
            style={isMobile || isTablet ? undefined : { width: columnWidthPx('small', false) }}
        >
            {sidebarContent}
        </div>
    );
}
