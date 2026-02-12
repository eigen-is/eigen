import {createContext, useContext} from 'react';

type ToolbarSlot = {
    columnId: string;
    width: string;
}

export type LayoutContextType = {
    appName: string;
    setAppName: (name: string) => void;
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    sidebarMode: 'collapsible' | 'hidden' | 'none';
    isMobile: boolean;
    isTablet: boolean;
    activeColumn: string | null;
    navigateToColumn: (id: string) => void;
    goBack: () => void;
    columnHistory: string[];
    toolbarSlots: ToolbarSlot[];
    registerToolbar: (columnId: string, width: string) => void;
    unregisterToolbar: (columnId: string) => void;
    getToolbarPortalNode: (columnId: string) => HTMLElement | null;
    getSecondaryToolbarPortalNode: () => HTMLElement | null;
}

export const LayoutContext = createContext<LayoutContextType>({
    appName: '',
    setAppName: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarMode: 'collapsible',
    isMobile: false,
    isTablet: false,
    activeColumn: null,
    navigateToColumn: () => {},
    goBack: () => {},
    columnHistory: [],
    toolbarSlots: [],
    registerToolbar: () => {},
    unregisterToolbar: () => {},
    getToolbarPortalNode: () => null,
    getSecondaryToolbarPortalNode: () => null,
});

export function useLayout() {
    return useContext(LayoutContext);
}

export function useApp() {
    const {appName, setAppName} = useLayout();
    return {appName, setAppName};
}

export function useSidebar() {
    const {sidebarOpen, setSidebarOpen} = useLayout();
    return {sidebarOpen, setSidebarOpen};
}
