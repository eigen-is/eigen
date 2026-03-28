import {createRootRouteWithContext, useMatch} from '@tanstack/react-router';
import type {AuthContextType} from '@workspace/lib/auth';
import {EigenDocRoot, STICKIES_CONFIG} from '@workspace/ui/components/layout/drive';

type MyRouterContext = {
    auth: AuthContextType;
};

function StickiesRoot() {
    const isEditorRoute = useMatch({from: '/_auth/board/$ownerId/$mountId/$pathId', shouldThrow: false});
    return <EigenDocRoot config={STICKIES_CONFIG} rootRoute={Route} isFullScreen={!!isEditorRoute}/>;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: StickiesRoot,
});
