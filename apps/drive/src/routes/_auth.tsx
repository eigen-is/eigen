import {createFileRoute, Outlet, redirect} from '@tanstack/react-router'
import {createContext} from 'react';
import {useRootFolder, DEFAULT_MOUNT_ID} from '@workspace/lib/drive';
import {EigenLoader} from '@workspace/ui';
import {useAuth} from '@workspace/lib/auth';
import {DriveSidebar} from '../components/drive/drive-sidebar';
import {DriveContextType} from '@workspace/lib/types/drive';
import {AppLayout} from "@workspace/ui/components/layout/app-layout";

export const DriveContext = createContext<DriveContextType>({
    rootPath: null,
    mountId: DEFAULT_MOUNT_ID
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
    const {user} = useAuth();
    const mountId = DEFAULT_MOUNT_ID;
    const {data: root, isLoading, error} = useRootFolder(user!.id, mountId);
    const rootPath = root || null;

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

    return (
        <AppLayout sidebar={({condensed, isMobile, onClose}) => (
            <DriveSidebar
                condensed={condensed}
                isMobile={isMobile}
                onClose={onClose}
                rootPath={rootPath}
            />
        )}>
            <DriveContext.Provider value={{rootPath, mountId}}>
                <Outlet/>
            </DriveContext.Provider>
        </AppLayout>
    );
}
