import { createContext, useContext } from 'react';

export type LayoutContextType = {
    appName: string;
    setAppName: (name: string) => void;
    documentTitle: string;
    setDocumentTitle: (title: string) => void;
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    // True while the mobile sidebar column has taken over the viewport — the one
    // source both AppShell (<main> hide) and SidebarContainer (show) read.
    sidebarColumnShown: boolean;
    sidebarMode: 'collapsible' | 'none';
    sidebarHidden: boolean;
    setSidebarHidden: (hidden: boolean) => void;
    isMobile: boolean;
    isTablet: boolean;
};

export const LayoutContext = createContext<LayoutContextType>({
    appName: '',
    setAppName: () => {},
    documentTitle: '',
    setDocumentTitle: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarColumnShown: false,
    sidebarMode: 'collapsible',
    sidebarHidden: false,
    setSidebarHidden: () => {},
    isMobile: false,
    isTablet: false,
});

export function useLayout() {
    return useContext(LayoutContext);
}

export function useApp() {
    const { appName, setAppName } = useLayout();
    return { appName, setAppName };
}
