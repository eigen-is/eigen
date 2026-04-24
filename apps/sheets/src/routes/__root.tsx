import { createRootRouteWithContext, useMatch } from '@tanstack/react-router';
import type { AuthContextType } from '@workspace/lib/auth';
import { EigenDocRoot, SHEETS_CONFIG } from '@workspace/ui/components/layout/drive';

type MyRouterContext = {
    auth: AuthContextType;
};

function SheetsRoot() {
    const isEditorRoute = useMatch({ from: '/_auth/sheet/$ownerId/$mountId/$pathId', shouldThrow: false });
    const teamDriveMatch = useMatch({ from: '/_auth/_sidebar/drive/$ownerId/$mountId', shouldThrow: false });
    return (
        <EigenDocRoot
            config={SHEETS_CONFIG}
            rootRoute={Route}
            isFullScreen={!!isEditorRoute}
            teamOwnerId={teamDriveMatch?.params.ownerId}
            teamMountId={teamDriveMatch?.params.mountId}
        />
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: SheetsRoot,
});
