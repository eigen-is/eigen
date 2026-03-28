import { createContext, useContext } from 'react';

export type LayoutContextType = {
    appName: string;
    setAppName: (name: string) => void;
    documentTitle: string;
    setDocumentTitle: (title: string) => void;
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    sidebarMode: 'collapsible' | 'hidden' | 'none';
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
    sidebarMode: 'collapsible',
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

export function useSidebar() {
    const { sidebarOpen, setSidebarOpen } = useLayout();
    return { sidebarOpen, setSidebarOpen };
}
