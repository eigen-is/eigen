import {ReactNode, useCallback, useState} from 'react';
import {Outlet} from '@tanstack/react-router';
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools';
import {useIsMobile, useIsTablet} from '@workspace/lib/media';
import {LayoutContext} from './layout-context';
import {Topbar} from './topbar';
import {SecondaryToolbar} from './secondary-toolbar';
import {SidebarContainer, SidebarProps} from './sidebar/sidebar-container';

type ToolbarEntry = {
    columnId: string;
    width: string;
    content: ReactNode;
}

type SecondaryToolbarEntry = {
    columnId: string;
    content: ReactNode;
}

type AppShellProps = {
    appName: string;
    rootRoute: {
        useNavigate: () => (...args: any[]) => any;
    };
    sidebar?: ReactNode | ((props: SidebarProps) => ReactNode);
    sidebarMode?: 'collapsible' | 'hidden' | 'none';
    children?: ReactNode;
}

export function AppShell({appName: initialAppName, rootRoute, sidebar, sidebarMode = 'collapsible', children}: AppShellProps) {
    const [appName, setAppName] = useState(initialAppName);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [activeColumn, setActiveColumn] = useState<string | null>(null);
    const [columnHistory, setColumnHistory] = useState<string[]>([]);
    const [toolbars, setToolbars] = useState<ToolbarEntry[]>([]);
    const [secondaryToolbars, setSecondaryToolbars] = useState<SecondaryToolbarEntry[]>([]);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const navigateToColumn = useCallback((id: string) => {
        setColumnHistory(prev => [...prev, id]);
        setActiveColumn(id);
    }, []);

    const goBack = useCallback(() => {
        setColumnHistory(prev => {
            if (prev.length <= 1) return prev;
            const newHistory = prev.slice(0, -1);
            setActiveColumn(newHistory[newHistory.length - 1] ?? null);
            return newHistory;
        });
    }, []);

    const registerToolbar = useCallback((columnId: string, width: string, content: ReactNode) => {
        setToolbars(prev => {
            const filtered = prev.filter(t => t.columnId !== columnId);
            return [...filtered, {columnId, width, content}];
        });
    }, []);

    const unregisterToolbar = useCallback((columnId: string) => {
        setToolbars(prev => prev.filter(t => t.columnId !== columnId));
    }, []);

    const registerSecondaryToolbar = useCallback((columnId: string, content: ReactNode) => {
        setSecondaryToolbars(prev => {
            const filtered = prev.filter(t => t.columnId !== columnId);
            return [...filtered, {columnId, content}];
        });
    }, []);

    const unregisterSecondaryToolbar = useCallback((columnId: string) => {
        setSecondaryToolbars(prev => prev.filter(t => t.columnId !== columnId));
    }, []);

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
            activeColumn,
            navigateToColumn,
            goBack,
            columnHistory,
            toolbars,
            registerToolbar,
            unregisterToolbar,
            secondaryToolbars,
            registerSecondaryToolbar,
            unregisterSecondaryToolbar,
        }}>
            <div className="flex flex-col h-dvh">
                <Topbar rootRoute={rootRoute}/>
                <SecondaryToolbar/>
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
