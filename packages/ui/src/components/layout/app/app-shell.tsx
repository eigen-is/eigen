// AppShell is the page frame of every Eigen app: the top bar, the sidebar and the main column.
// It owns the layout state that useLayout() hands to the app, such as the app name, the document
// title and whether the sidebar is open. For a signed-in user it also mounts the command palette
// and the create dialogs the palette opens. At its foot sit the strips that speak to every app,
// such as the warning of a restart the server announced.

import { Outlet } from '@tanstack/react-router';
import { openMailComposeWith } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { useCommandPalette, useOptionalCommandPalette } from '@workspace/lib/command-palette';
import { subjectFromPath } from '@workspace/lib/file-subject';
import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { useMailEnabled } from '@workspace/lib/public';
import { useTheme } from '@workspace/lib/space';
import type { CommandContext } from '@workspace/lib/types/command-palette';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { DriveCreateEigenDoc } from '../../drive/drive-create-eigendoc';
import { DriveCreateFolder } from '../../drive/drive-create-folder';
import { useOptionalPreview, usePreview } from '../../preview-provider/preview-provider';
import type { SidebarProps } from '../sidebar/sidebar-container';
import { SidebarContainer } from '../sidebar/sidebar-container';
import { CommandPalette } from './command-palette/command-palette';
import { usePaletteShortcuts } from './command-palette/use-palette-shortcuts';
import { DemoBanner } from './demo-banner';
import { LayoutContext } from './layout-context';
import { RestartBanner } from './restart-banner';
import { Topbar } from './topbar';

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

    // On mobile the open sidebar takes the place of <main>. Main is hidden, not unmounted, so an
    // editor keeps its collab connection and a list keeps its scroll position.
    const sidebarColumnShown = isMobile && sidebarOpen && effectiveSidebarMode === 'collapsible';

    // A stable context value, so a resize or a new title does not re-render every useLayout()
    // caller. The useState setters never change, so they need no place in the dependencies.
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
                <RestartBanner />
                <DemoBanner />
            </div>
        </LayoutContext.Provider>
    );
}

// The create dialog the palette asked for with openDriveCreate, or null when none is open.
type CreateDialogKind = EigenDocType | 'folder' | null;

// The index app's public pages, such as the blog, render AppShell without EigenApp, so they have
// no command palette or preview provider. There this renders nothing, which lets
// PaletteRunnerInner read both providers without a check.
function PaletteRunner() {
    const palette = useOptionalCommandPalette();
    const preview = useOptionalPreview();
    const auth = useAuth();
    // The palette is for signed-in users only, so for a visitor Mod+K does nothing.
    if (!palette || !preview || !auth.isAuthenticated) return null;
    return <PaletteRunnerInner />;
}

function PaletteRunnerInner() {
    usePaletteShortcuts();
    const auth = useAuth();
    const { selection, selectionActions, docSearch, docSearchSession, docCommentSearch } = useCommandPalette();
    const { theme, setTheme } = useTheme();
    const { openPreview } = usePreview();
    const mailEnabled = useMailEnabled();
    const [createDialog, setCreateDialog] = useState<CreateDialogKind>(null);

    // The palette hands out drive paths, and the preview takes subjects. It is memoized because
    // the palette context below is rebuilt whenever one of its parts changes.
    const openPathPreview = useCallback((path: DrivePath) => openPreview(subjectFromPath(path)), [openPreview]);

    const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

    const ownerId = auth.user?.id ?? '';

    const ctx = useMemo<CommandContext>(
        () => ({
            ownerId,
            mailEnabled,
            selection,
            selectionActions,
            docSearch,
            docSearchSession,
            docCommentSearch,
            navigate: (url) => {
                window.location.href = url;
            },
            // The same create dialogs as the New menu in the Drive sidebar. The dialog asks
            // the user where to create.
            openDriveCreate: (kind) => setCreateDialog(kind),
            openMailComposeWith,
            openPreview: openPathPreview,
            toggleTheme,
        }),
        [
            ownerId,
            mailEnabled,
            selection,
            selectionActions,
            docSearch,
            docSearchSession,
            docCommentSearch,
            openPathPreview,
            toggleTheme,
        ],
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
