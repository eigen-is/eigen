import {ReactNode} from 'react';
import {useLayout} from '../app/layout-context.tsx';

export type SidebarProps = {
    condensed: boolean;
    isMobile: boolean;
    onClose: () => void;
}

type SidebarContainerProps = {
    sidebar: ReactNode | ((props: SidebarProps) => ReactNode);
}

export function SidebarContainer({sidebar}: SidebarContainerProps) {
    const {sidebarOpen, setSidebarOpen, sidebarMode, isMobile, isTablet} = useLayout();

    if (sidebarMode === 'none') return null;

    const sidebarContent = typeof sidebar === 'function'
        ? sidebar({condensed: isTablet, isMobile, onClose: () => setSidebarOpen(false)})
        : sidebar;

    return (
        <>
            <div
                className={`
                    ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                    ${isTablet ? 'w-16' : 'w-64'} 
                    border-r h-full min-h-full
                `}
            >
                {sidebarContent}
            </div>

            {isMobile && sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-background/80"
                    onClick={() => setSidebarOpen(false)}
                />
            )}
        </>
    );
}
