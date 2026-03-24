import {lazy, ReactNode, Suspense, useState} from 'react';
import {Outlet} from '@tanstack/react-router';
import {useIsMobile, useIsTablet} from '@workspace/lib/media';
import {LayoutContext} from './layout-context.tsx';
import {Topbar} from './topbar.tsx';
import {SidebarContainer, SidebarProps} from '../sidebar/sidebar-container.tsx';

const TanStackRouterDevtools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-router-devtools').then(m => ({default: m.TanStackRouterDevtools})))
    : () => null;

type AppShellProps = {
    appName: string;
    rootRoute: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack Router's useNavigate has app-specific types
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
    const [documentTitle, setDocumentTitle] = useState('');
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const effectiveSidebarMode = sidebar ? sidebarMode : 'none';

    return (
        <LayoutContext.Provider value={{
            appName,
            setAppName,
            documentTitle,
            setDocumentTitle,
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
            <Suspense>
                <TanStackRouterDevtools position="bottom-left"/>
            </Suspense>
        </LayoutContext.Provider>
    );
}
