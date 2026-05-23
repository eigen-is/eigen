import { Outlet } from '@tanstack/react-router';
import { openMailComposeWith } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCommandPalette } from '@workspace/lib/command-palette';
import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import type { AppName, CommandContext } from '@workspace/lib/types/command-palette';
import type { EigenDocType } from '@workspace/lib/types/drive';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from 'react';
import { DriveCreateEigenDoc } from '../drive/drive-create-eigendoc.tsx';
import { DriveCreateFolder } from '../drive/drive-create-folder.tsx';
import { usePreview } from '../preview-provider/preview-provider.tsx';
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

// What `ctx.openDriveCreate(kind)` puts on the wire. `null` = no dialog open;
// an EigenDocType opens DriveCreateEigenDoc; 'folder' opens DriveCreateFolder.
type CreateDialogKind = EigenDocType | 'folder' | null;

function PaletteRunner() {
    usePaletteShortcuts();
    const auth = useAuth();
    const { appName } = useLayout();
    const { selection, selectionActions } = useCommandPalette();
    const { data: settings } = useSpaceSettings();
    const updateSettings = useUpdateSpaceSettings();
    const { openPreview } = usePreview();
    const [createDialog, setCreateDialog] = useState<CreateDialogKind>(null);

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
            selectionActions,
            navigate: (url) => {
                window.location.href = url;
            },
            // Open the same shared dialogs the Drive sidebar's New menu uses
            // (drive-new-menu.tsx). The dialog's DriveLocationPicker lets the user
            // pick where to create.
            openDriveCreate: (kind) => setCreateDialog(kind),
            openMailComposeWith,
            openPreview: (path) => openPreview(path),
            toggleTheme,
        }),
        [ownerId, currentApp, selection, selectionActions, openPreview, toggleTheme],
    );

    const eigenDocKind = createDialog && createDialog !== 'folder' ? createDialog : null;

    return (
        <>
            <CommandPalette ctx={ctx} />
            {eigenDocKind && (
                <DriveCreateEigenDoc
                    type={eigenDocKind}
                    open
                    onOpenChange={(open) => {
                        if (!open) setCreateDialog(null);
                    }}
                    defaultOwnerId={ownerId}
                />
            )}
            <DriveCreateFolder
                open={createDialog === 'folder'}
                onOpenChange={(open) => {
                    if (!open) setCreateDialog(null);
                }}
                defaultOwnerId={ownerId}
            />
        </>
    );
}
