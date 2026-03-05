import {ReactNode, useState} from 'react';
import {Outlet} from '@tanstack/react-router';
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools';
import {useIsMobile, useIsTablet} from '@workspace/lib/lib/media';
import {LayoutContext} from './layout-context.tsx';
import {Topbar} from './topbar.tsx';
import {SidebarContainer, SidebarProps} from '../sidebar/sidebar-container.tsx';

type AppShellProps = {
    appName: string;
    rootRoute: {
        useNavigate: () => (...args: any[]) => any;
    };
    sidebar?: ReactNode | ((props: SidebarProps) => ReactNode);
    sidebarMode?: 'collapsible' | 'hidden' | 'none';
    children?: ReactNode;
}

export function AppShell({
                             appName: initialAppName,
                             rootRoute,
                             sidebar,
                             sidebarMode = 'collapsible',
                             children
                         }: AppShellProps) {
    const [appName, setAppName] = useState(initialAppName);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const effectiveSidebarMode = sidebar ? sidebarMode : 'none';

    return (
        <LayoutContext.Provider value={{
            appName,
            setAppName,
            sidebarOpen,
            setSidebarOpen,
            sidebarMode: effectiveSidebarMode,
            isMobile,
            isTablet,
        }}>
            <div className="flex flex-col h-dvh">
                <Topbar rootRoute={rootRoute}/>
                <div className="flex flex-1 w-full overflow-hidden">
                    {sidebar && <SidebarContainer sidebar={sidebar}/>}
                    <main className="flex-1 flex h-full overflow-hidden">
                        {children ?? <Outlet/>}
                    </main>
                </div>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </LayoutContext.Provider>
    );
}
