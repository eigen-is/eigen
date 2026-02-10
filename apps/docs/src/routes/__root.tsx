import {createRootRouteWithContext, useMatch} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {RootLayout} from "@workspace/ui/components/layout/root-layout";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => {
        const routeMatch = useMatch({
            from: '/_auth/doc/$ownerId/$mountId/$pathId',
            shouldThrow: false,
        });
        return <RootLayout rootRoute={Route} hideMenuOnRoute={!!routeMatch}/>;
    }
});
