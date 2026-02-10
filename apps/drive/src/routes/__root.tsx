import {createRootRouteWithContext} from '@tanstack/react-router'
import {AuthContextType} from "@workspace/lib/auth";
import {RootLayout} from "@workspace/ui/components/layout/root-layout";

interface MyRouterContext {
    auth: AuthContextType
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: () => <RootLayout rootRoute={Route}/>,
});
