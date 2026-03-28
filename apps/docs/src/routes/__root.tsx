import {createRootRouteWithContext, useMatch} from '@tanstack/react-router';
import type {AuthContextType} from '@workspace/lib/auth';
import {DOCS_CONFIG, EigenDocRoot} from '@workspace/ui/components/layout/drive';

type MyRouterContext = {
    auth: AuthContextType;
};

function DocsRoot() {
    const isEditorRoute = useMatch({from: '/_auth/doc/$ownerId/$mountId/$pathId', shouldThrow: false});
    return <EigenDocRoot config={DOCS_CONFIG} rootRoute={Route} isFullScreen={!!isEditorRoute}/>;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: DocsRoot,
});
