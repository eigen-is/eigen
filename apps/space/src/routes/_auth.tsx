import {createFileRoute, redirect} from '@tanstack/react-router'
import {SpaceSidebar} from "../components/space/space-sidebar";
import {AppLayout} from "@workspace/ui/components/layout/app-layout";

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
    return (
        <AppLayout
            sidebar={({condensed, isMobile, onClose}) => (
                <SpaceSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                />
            )}
            mainClassName="flex-1 flex flex-col h-full overflow-hidden"
        />
    );
}
