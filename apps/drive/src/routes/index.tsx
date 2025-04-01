import {createFileRoute} from '@tanstack/react-router'
import {useRootFolder} from '@/hooks/use-drive';
import {useEffect} from 'react';
import {EigenLoader} from '@workspace/ui';

export const Route = createFileRoute('/')({
    component: HomeComponent,
})

function HomeComponent() {
    const navigate = Route.useNavigate();
    const {data: rootFolder, isLoading, error} = useRootFolder();
    
    useEffect(() => {
        if (rootFolder?.id) {
            navigate({
                to: '/drive/$pathId',
                params: {
                    pathId: rootFolder.id
                }
            });
        }
    }, [rootFolder, navigate]);
    
    // Show loading state while fetching root folder
    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-screen">
                <EigenLoader />
            </div>
        );
    }
    
    // Show error if we couldn't get the root folder
    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-screen">
                <p className="text-red-500">Error loading drive</p>
                <p className="text-sm">{(error as Error).message}</p>
            </div>
        );
    }
    
    // This will render briefly while the navigation happens
    return (
        <div className="flex items-center justify-center h-screen">
            <EigenLoader />
        </div>
    );
}
