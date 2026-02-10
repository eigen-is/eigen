import {ReactNode} from 'react';
import {Outlet} from '@tanstack/react-router';
import {useSidebar} from './root-layout';
import {useIsMobile, useIsTablet} from '@workspace/lib/media';

export type SidebarProps = {
    condensed: boolean;
    isMobile: boolean;
    onClose: () => void;
}

type AppLayoutProps = {
    sidebar: ReactNode | ((props: SidebarProps) => ReactNode);
    children?: ReactNode;
    mainClassName?: string;
}

export function AppLayout({sidebar, children, mainClassName = 'flex-1 flex h-full overflow-hidden'}: AppLayoutProps) {
    const {sidebarOpen, setSidebarOpen} = useSidebar();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const sidebarContent = typeof sidebar === 'function'
        ? sidebar({condensed: isTablet, isMobile, onClose: () => setSidebarOpen(false)})
        : sidebar;

    return (
        <div className="flex flex-1 w-full h-full overflow-hidden">
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

            <main className={mainClassName}>
                {children ?? <Outlet/>}
            </main>
        </div>
    );
}
