import { createRootRouteWithContext, useMatch } from '@tanstack/react-router';
import type { AuthContextType } from '@workspace/lib/auth';
import { EigenDocRoot, SLIDES_CONFIG } from '@workspace/ui/components/layout/drive';

type MyRouterContext = {
    auth: AuthContextType;
};

function SlidesRoot() {
    const isEditorRoute = useMatch({ from: '/_auth/slide/$ownerId/$mountId/$pathId', shouldThrow: false });
    return <EigenDocRoot config={SLIDES_CONFIG} rootRoute={Route} isFullScreen={!!isEditorRoute} />;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: SlidesRoot,
});
