import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {createContext, useContext} from 'react';
import {SidebarContext} from './__root';
import {useRootFolder} from '@workspace/lib/drive';
import {EigenLoader} from '@workspace/ui';
import {useAuth} from '@workspace/lib/auth/auth-context.js';
import {useIsMobile, useIsTablet} from "@workspace/lib/media";
import {DocsSidebar} from "@/components/docs/docs-sidebar.tsx";

// Create a drive context to share data with child routes
export interface DriveContextType {
  rootPath: DrivePath | null;
}

export const DriveContext = createContext<DriveContextType>({
  rootPath: null
});

export const Route = createFileRoute('/_auth/_sidebar')({
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
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const {user} = useAuth();

  // Get root folder information
  const {data: rootFolder, isLoading: isRootLoading, error: rootError} = useRootFolder(user.id);
  const rootPath = rootFolder || null;

  // Loading state
  const isLoading = isRootLoading;
  const error = rootError;

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
    rootPath
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
          <DocsSidebar
              condensed={isTablet}
              isMobile={isMobile}
              onClose={() => setSidebarOpen(false)}
              rootPath={rootPath}
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
