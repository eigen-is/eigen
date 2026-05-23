import { Outlet } from '@tanstack/react-router';
import { getDriveAppUrl, openMailComposeWith } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCommandPalette } from '@workspace/lib/command-palette';
import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import type { AppName, CommandContext } from '@workspace/lib/types/command-palette';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from 'react';
import { SidebarContainer, type SidebarProps } from '../sidebar/sidebar-container.tsx';
import { CommandPalette } from './command-palette/command-palette.tsx';
import { usePaletteShortcuts } from './command-palette/use-palette-shortcuts.ts';
import { LayoutContext, useLayout } from './layout-context.tsx';
import { Topbar } from './topbar.tsx';

// Browser-only dev widget — never render it during SSR/prerender, where
// renderToString cannot handle the lazy component's Suspense boundary.
const TanStackRouterDevtools =
    import.meta.env.DEV && !import.meta.env.SSR
        ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
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
    const [sidebarHidden, setSidebarHidden] = useState(false);

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const effectiveSidebarMode = sidebar && !sidebarHidden ? sidebarMode : 'none';

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
                sidebarHidden,
                setSidebarHidden,
                isMobile,
                isTablet,
            }}
        >
            <div className="flex flex-col h-dvh">
                <Topbar rootRoute={rootRoute} />
                <PaletteRunner />
                <div className="flex flex-1 w-full overflow-hidden">
                    {sidebar && !sidebarHidden && <SidebarContainer sidebar={sidebar} />}
                    <main className="flex-1 flex h-full overflow-hidden">{children ?? <Outlet />}</main>
                </div>
            </div>
            <Suspense>
                <TanStackRouterDevtools position="bottom-left" />
            </Suspense>
        </LayoutContext.Provider>
    );
}

function PaletteRunner() {
    usePaletteShortcuts();
    const auth = useAuth();
    const { appName } = useLayout();
    const { selection } = useCommandPalette();
    const { data: settings } = useSpaceSettings();
    const updateSettings = useUpdateSpaceSettings();

    const toggleTheme = useCallback(() => {
        const next = settings?.theme === 'dark' ? 'light' : 'dark';
        updateSettings.mutate({ theme: next });
    }, [settings?.theme, updateSettings]);

    const ownerId = auth.user?.id ?? '';
    const currentApp = appName.toLowerCase() as AppName;

    const ctx = useMemo<CommandContext>(
        () => ({
            ownerId,
            currentApp,
            selection,
            navigate: (url) => {
                window.location.href = url;
            },
            openDriveCreate: (kind) => {
                window.location.href = getDriveAppUrl(`${ownerId}?create=${encodeURIComponent(kind)}`);
            },
            openMailComposeWith,
            toggleTheme,
        }),
        [ownerId, currentApp, selection, toggleTheme],
    );

    return <CommandPalette ctx={ctx} />;
}
