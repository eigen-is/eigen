import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {createContext, useContext} from 'react';
import {SidebarContext} from './__root';
import {useFolderContent, useMediaQuery, useRootFolder} from '@workspace/lib/drive';
import {DriveSidebar} from "@/components/drive/drive-sidebar.tsx";
import {EigenLoader} from '@workspace/ui';
import { useAuth } from '@workspace/lib/auth/auth-context.js';

// Create a drive context to share data with child routes
export interface DriveContextType {
    rootPathId: string | undefined;
}

export const DriveContext = createContext<DriveContextType>({
    rootPathId: undefined
});

export const Route = createFileRoute('/_auth')({
    beforeLoad: ({context, location}) => {
        if (!context.auth.isAuthenticated) {
            throw redirect({
                to: '/login',
                search: {
                    redirect: location.href,
                },
            })
        }
    },
    component: AuthLayout,
})

function AuthLayout() {
    const {sidebarOpen, setSidebarOpen} = useContext(SidebarContext);
    const isMobile = useMediaQuery('(max-width: 768px)');
    const isTablet = useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
    const {user} = useAuth();
    // const isDesktop = useMediaQuery('(min-width: 1025px)');

    // Get root folder information
    const {data: rootFolder, isLoading: isRootLoading, error: rootError} = useRootFolder(user.id);
    const rootPathId = rootFolder?.id;

    // Get contents of the root folder
    const {data: folders = [], isLoading: isFoldersLoading, error: isFoldersError} = useFolderContent(user.id, rootPathId || '');

    // Loading state
    const isLoading = isRootLoading || isFoldersLoading;
    const error = rootError || isFoldersError;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-screen w-screen">
                <EigenLoader/>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-screen w-screen">
                <p className="text-red-500">Error loading drive content</p>
                <p className="text-sm">{error.message}</p>
            </div>
        );
    }

    // Create context value to pass to child routes
    const driveContextValue: DriveContextType = {
        rootPathId
    };

    return (
        <div className="flex flex-1 w-full h-full overflow-hidden">
            {/* Sidebar: First column - always visible on desktop/tablet, overlay on mobile */}
            <div
                className={`
                        ${isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block'}
                        ${isTablet ? 'w-16' : 'w-64'} 
                        border-r h-full min-h-full
                    `}
            >
                <DriveSidebar
                    condensed={isTablet}
                    isMobile={isMobile}
                    onClose={() => setSidebarOpen(false)}
                    rootPath={`/fs/${rootFolder?.ownerId}/${rootFolder?.id}`}   
                    error={error}
                />
            </div>

            {/* Backdrop for mobile to close sidebar when clicking outside */}
            {isMobile && sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-background/80"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Main content area - contains columns 2 and 3 */}
            <main className="flex-1 flex h-full overflow-hidden">
                <DriveContext.Provider value={driveContextValue}>
                    <Outlet/>
                </DriveContext.Provider>
            </main>
        </div>
    );
}
