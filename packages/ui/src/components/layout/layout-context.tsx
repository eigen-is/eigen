import {createContext, ReactNode, useContext} from 'react';

type ToolbarEntry = {
    columnId: string;
    width: string;
    content: ReactNode;
}

type SecondaryToolbarEntry = {
    columnId: string;
    content: ReactNode;
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
    toolbars: ToolbarEntry[];
    registerToolbar: (columnId: string, width: string, content: ReactNode) => void;
    unregisterToolbar: (columnId: string) => void;
    secondaryToolbars: SecondaryToolbarEntry[];
    registerSecondaryToolbar: (columnId: string, content: ReactNode) => void;
    unregisterSecondaryToolbar: (columnId: string) => void;
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
    toolbars: [],
    registerToolbar: () => {},
    unregisterToolbar: () => {},
    secondaryToolbars: [],
    registerSecondaryToolbar: () => {},
    unregisterSecondaryToolbar: () => {},
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
