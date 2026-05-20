import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { LayoutContext } from '@workspace/ui/components/layout/app/layout-context';
import { type ReactNode, useMemo } from 'react';
import { SupportHeader } from './support-header';
import { SupportSearchProvider } from './support-search';

// The help center's analogue of AppShell: a public header plus a LayoutContext
// provider, so ColumnLayout/Column render exactly as they do inside the apps.
export function SupportShell({ children }: { children: ReactNode }) {
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const layout = useMemo(
        () => ({
            appName: 'support',
            setAppName: () => {},
            documentTitle: '',
            setDocumentTitle: () => {},
            sidebarOpen: false,
            setSidebarOpen: () => {},
            sidebarMode: 'none' as const,
            sidebarHidden: true,
            setSidebarHidden: () => {},
            isMobile,
            isTablet,
        }),
        [isMobile, isTablet],
    );

    return (
        <LayoutContext.Provider value={layout}>
            <SupportSearchProvider>
                <div className="flex flex-col h-dvh">
                    <SupportHeader />
                    <div className="flex flex-1 w-full overflow-hidden">{children}</div>
                </div>
            </SupportSearchProvider>
        </LayoutContext.Provider>
    );
}
