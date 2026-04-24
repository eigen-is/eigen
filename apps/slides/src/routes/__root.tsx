import { createRootRouteWithContext, useMatch } from '@tanstack/react-router';
import type { AuthContextType } from '@workspace/lib/auth';
import { EigenDocRoot, SLIDES_CONFIG } from '@workspace/ui/components/layout/drive';

type MyRouterContext = {
    auth: AuthContextType;
};

function SlidesRoot() {
    const isEditorRoute = useMatch({ from: '/_auth/slide/$ownerId/$mountId/$pathId', shouldThrow: false });
    const teamDriveMatch = useMatch({ from: '/_auth/_sidebar/drive/$ownerId/$mountId', shouldThrow: false });
    return (
        <EigenDocRoot
            config={SLIDES_CONFIG}
            rootRoute={Route}
            isFullScreen={!!isEditorRoute}
            teamOwnerId={teamDriveMatch?.params.ownerId}
            teamMountId={teamDriveMatch?.params.mountId}
        />
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: SlidesRoot,
});
