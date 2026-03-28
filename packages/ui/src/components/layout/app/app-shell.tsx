import {Outlet} from '@tanstack/react-router';
import {useIsMobile, useIsTablet} from '@workspace/lib/media';
import {lazy, type ReactNode, Suspense, useState} from 'react';
import {SidebarContainer, type SidebarProps} from '../sidebar/sidebar-container.tsx';
import {LayoutContext} from './layout-context.tsx';
import {Topbar} from './topbar.tsx';

const TanStackRouterDevtools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({default: m.TanStackRouterDevtools})))
    : () => null;

type AppShellProps = {
    appName: string;
    rootRoute: {
        useNavigate: () => (opts: { to: string }) => unknown;
    };
    sidebar?: ReactNode | ((props: SidebarProps) => ReactNode);
    sidebarMode?: 'collapsible' | 'hidden' | 'none';
    children?: ReactNode;
};

export function AppShell({
                             appName: initialAppName,
                             rootRoute,
                             sidebar,
                             sidebarMode = 'collapsible',
                             children,
                         }: AppShellProps) {
    const [appName, setAppName] = useState(initialAppName);
    const [documentTitle, setDocumentTitle] = useState('');
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const effectiveSidebarMode = sidebar ? sidebarMode : 'none';

    return (
        <LayoutContext.Provider
            value={{
                appName,
                setAppName,
                documentTitle,
                setDocumentTitle,
                sidebarOpen,
                setSidebarOpen,
                sidebarMode: effectiveSidebarMode,
                isMobile,
                isTablet,
            }}
        >
            <div className="flex flex-col h-dvh">
                <Topbar rootRoute={rootRoute}/>
                <div className="flex flex-1 w-full overflow-hidden">
                    {sidebar && <SidebarContainer sidebar={sidebar}/>}
                    <main className="flex-1 flex h-full overflow-hidden">{children ?? <Outlet/>}</main>
                </div>
            </div>
            <Suspense>
                <TanStackRouterDevtools position="bottom-left"/>
            </Suspense>
        </LayoutContext.Provider>
    );
}
