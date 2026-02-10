import {Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {Topbar} from './topbar'
import {createContext, useContext, useState} from 'react'
import {useIsMobile} from '@workspace/lib/media'

export const SidebarContext = createContext<{
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
}>({
    sidebarOpen: false,
    setSidebarOpen: () => {},
});

export function useSidebar() {
    return useContext(SidebarContext);
}

type RootLayoutProps = {
    rootRoute: {
        useNavigate: () => (...args: any[]) => any;
    };
    hideMenuOnRoute?: boolean;
    outletWrapper?: string;
}

export function RootLayout({rootRoute, hideMenuOnRoute, outletWrapper}: RootLayoutProps) {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const isMobile = useIsMobile();

    const showMobileMenu = hideMenuOnRoute !== undefined ? !hideMenuOnRoute : isMobile;

    return (
        <SidebarContext.Provider value={{sidebarOpen, setSidebarOpen}}>
            <div className="flex flex-col h-dvh">
                <Topbar
                    rootRoute={rootRoute}
                    showMobileMenu={showMobileMenu}
                    onMobileMenuClick={() => setSidebarOpen(true)}
                    isMobile={isMobile}
                />
                {outletWrapper ? (
                    <div className={outletWrapper}>
                        <Outlet/>
                    </div>
                ) : (
                    <Outlet/>
                )}
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </SidebarContext.Provider>
    );
}
