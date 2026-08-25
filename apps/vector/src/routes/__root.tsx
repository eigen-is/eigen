import { createRootRouteWithContext, useMatch } from '@tanstack/react-router';
import type { RouterAppContext } from '@workspace/lib/auth';
import { EigenDocRoot, VECTOR_CONFIG } from '@workspace/ui/components/drive';

function VectorRoot() {
    const isEditorRoute = useMatch({ from: '/_auth/vector/$ownerId/$mountId/$pathId', shouldThrow: false });
    const teamDriveMatch = useMatch({ from: '/_auth/_sidebar/drive/$ownerId/$mountId', shouldThrow: false });
    return (
        <EigenDocRoot
            config={VECTOR_CONFIG}
            rootRoute={Route}
            isFullScreen={!!isEditorRoute}
            teamOwnerId={teamDriveMatch?.params.ownerId}
            teamMountId={teamDriveMatch?.params.mountId}
        />
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: VectorRoot,
});
