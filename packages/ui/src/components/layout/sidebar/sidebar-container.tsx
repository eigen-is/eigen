import { useLocation } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { cn } from '../../../lib/utils';
import { useLayout } from '../app/layout-context';

export type SidebarProps = {
    condensed: boolean;
};

type SidebarContainerProps = {
    sidebar: ReactNode | ((props: SidebarProps) => ReactNode);
};

export function SidebarContainer({ sidebar }: SidebarContainerProps) {
    const { sidebarOpen, setSidebarOpen, sidebarColumnShown, sidebarMode, isMobile, isTablet } = useLayout();
    // href (not pathname) so the mobile sidebar column also closes on search-param
    // navigation — e.g. mail's ?mode=compose, which keeps the same pathname.
    const { href } = useLocation();

    useEffect(() => {
        if (isMobile && sidebarOpen) setSidebarOpen(false);
    }, [href]);

    if (sidebarMode === 'none') return null;

    const sidebarContent = typeof sidebar === 'function' ? sidebar({ condensed: isTablet }) : sidebar;

    return (
        <div
            className={cn(
                // Items are padded pills, so the sidebar narrows the gutter to 12px from sm up;
                // the w-16 rail is the 40px primary button plus that gutter on each side.
                'border-r h-full overflow-y-auto overflow-x-hidden bg-sidebar sm:[--app-gutter-x:0.75rem]',
                isMobile ? (sidebarColumnShown ? 'block w-full' : 'hidden') : isTablet ? 'block w-16' : 'block w-64',
            )}
        >
            {sidebarContent}
        </div>
    );
}
