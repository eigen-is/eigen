import {ReactNode, useCallback, useState} from 'react';
import {Outlet} from '@tanstack/react-router';
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools';
import {useIsMobile, useIsTablet} from '@workspace/lib/media';
import {LayoutContext} from './layout-context';
import {Topbar} from './topbar';
import {SecondaryToolbar} from './secondary-toolbar';
import {SidebarContainer, SidebarProps} from './sidebar/sidebar-container';

type ToolbarSlot = {
    columnId: string;
    width: string;
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
    const [toolbarSlots, setToolbarSlots] = useState<ToolbarSlot[]>([]);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const navigateToColumn = useCallback((id: string) => {
        setActiveColumn(prev => {
            if (prev === id) return prev;
            setColumnHistory(h => [...h, id]);
            return id;
        });
    }, []);

    const goBack = useCallback(() => {
        setColumnHistory(prev => {
            if (prev.length <= 1) return prev;
            const newHistory = prev.slice(0, -1);
            const newActive = newHistory[newHistory.length - 1] ?? null;
            setActiveColumn(newActive);
            return newHistory;
        });
    }, []);

    const registerToolbar = useCallback((columnId: string, width: string) => {
        setToolbarSlots(prev => {
            if (prev.some(s => s.columnId === columnId && s.width === width)) return prev;
            return [...prev.filter(s => s.columnId !== columnId), {columnId, width}];
        });
    }, []);

    const unregisterToolbar = useCallback((columnId: string) => {
        setToolbarSlots(prev => {
            if (!prev.some(s => s.columnId === columnId)) return prev;
            return prev.filter(s => s.columnId !== columnId);
        });
    }, []);

    const getToolbarPortalNode = useCallback((columnId: string): HTMLElement | null => {
        return document.querySelector(`[data-toolbar-slot="${columnId}"]`);
    }, []);

    const getSecondaryToolbarPortalNode = useCallback((): HTMLElement | null => {
        return document.querySelector('[data-secondary-toolbar-slot]');
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
            toolbarSlots,
            registerToolbar,
            unregisterToolbar,
            getToolbarPortalNode,
            getSecondaryToolbarPortalNode,
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
