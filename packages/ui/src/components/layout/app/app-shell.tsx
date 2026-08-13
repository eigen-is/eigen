import { Outlet } from '@tanstack/react-router';
import { openMailComposeWith } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCommandPalette, useOptionalCommandPalette } from '@workspace/lib/command-palette';
import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import type { CommandContext } from '@workspace/lib/types/command-palette';
import type { EigenDocType } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from 'react';
import { DriveCreateEigenDoc } from '../../drive/drive-create-eigendoc';
import { DriveCreateFolder } from '../../drive/drive-create-folder';
import { useOptionalPreview, usePreview } from '../../preview-provider/preview-provider';
import { SidebarContainer, type SidebarProps } from '../sidebar/sidebar-container';
import { CommandPalette } from './command-palette/command-palette';
import { usePaletteShortcuts } from './command-palette/use-palette-shortcuts';
import { DemoBanner } from './demo-banner';
import { LayoutContext } from './layout-context';
import { Topbar } from './topbar';

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
    sidebarMode?: 'collapsible' | 'none';
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

    // On mobile the sidebar renders as a full-width column in place of <main>. Hide main
    // via CSS instead of unmounting so editors keep Yjs/WS state and lists keep scroll.
    const sidebarColumnShown = isMobile && sidebarOpen && effectiveSidebarMode === 'collapsible';

    // Memoize so the context value keeps a stable identity across AppShell
    // re-renders (resize, sidebar toggle, title changes) — without it every
    // useLayout() consumer re-renders on each render. useState setters are stable.
    const layoutValue = useMemo(
        () => ({
            appName,
            setAppName,
            documentTitle,
            setDocumentTitle,
            sidebarOpen,
            setSidebarOpen,
            sidebarColumnShown,
            sidebarMode: effectiveSidebarMode,
            sidebarHidden,
            setSidebarHidden,
            isMobile,
            isTablet,
        }),
        [
            appName,
            documentTitle,
            sidebarOpen,
            sidebarColumnShown,
            effectiveSidebarMode,
            sidebarHidden,
            isMobile,
            isTablet,
        ],
    );

    return (
        <LayoutContext.Provider value={layoutValue}>
            <div className="flex flex-col h-dvh">
                <Topbar rootRoute={rootRoute} />
                <PaletteRunner />
                <div className="flex flex-1 w-full overflow-hidden">
                    {sidebar && !sidebarHidden && <SidebarContainer sidebar={sidebar} />}
                    <main className={cn('flex-1 flex h-full overflow-hidden', sidebarColumnShown && 'hidden')}>
                        {children ?? <Outlet />}
                    </main>
                </div>
                <DemoBanner />
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

// AppShell is used by both EigenApp-wrapped apps (mail/drive/docs/…) and the
// index app's marketing routes (blog/support), which don't mount the
// CommandPaletteProvider + PreviewProvider stack. Render nothing in the latter
// case so PaletteRunnerInner can use the required hooks without guards.
function PaletteRunner() {
    const palette = useOptionalCommandPalette();
    const preview = useOptionalPreview();
    const auth = useAuth();
    // Palette is signed-in-only: skip Inner for anonymous visitors so Mod+K never binds.
    if (!palette || !preview || !auth.isAuthenticated) return null;
    return <PaletteRunnerInner />;
}

function PaletteRunnerInner() {
    usePaletteShortcuts();
    const auth = useAuth();
    const { selection, selectionActions, docSearch, docSearchSession, docCommentSearch } = useCommandPalette();
    const { data: settings } = useSpaceSettings();
    const updateSettings = useUpdateSpaceSettings();
    const { openPreview } = usePreview();
    const [createDialog, setCreateDialog] = useState<CreateDialogKind>(null);

    const toggleTheme = useCallback(() => {
        const next = settings?.theme === 'dark' ? 'light' : 'dark';
        updateSettings.mutate({ theme: next });
    }, [settings?.theme, updateSettings]);

    const ownerId = auth.user?.id ?? '';

    const ctx = useMemo<CommandContext>(
        () => ({
            ownerId,
            selection,
            selectionActions,
            docSearch,
            docSearchSession,
            docCommentSearch,
            navigate: (url) => {
                window.location.href = url;
            },
            // Open the same shared dialogs the Drive sidebar's New menu uses
            // (drive-new-menu.tsx). The dialog's DriveLocationPicker lets the user
            // pick where to create.
            openDriveCreate: (kind) => setCreateDialog(kind),
            openMailComposeWith,
            openPreview,
            toggleTheme,
        }),
        [ownerId, selection, selectionActions, docSearch, docSearchSession, docCommentSearch, openPreview, toggleTheme],
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
