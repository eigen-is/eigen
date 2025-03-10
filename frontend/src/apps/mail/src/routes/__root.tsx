import {createRootRoute, Outlet} from '@tanstack/react-router'
import {TanStackRouterDevtools} from '@tanstack/react-router-devtools'
import {Topbar} from "@/components/layout/topbar";
import {AppSidebar} from "@/components/mail/app-sidebar";

export const Route = createRootRoute({
    component: RootComponent,
})

function RootComponent() {
    return (
        <>
            <div className="flex flex-col h-screen">
                <Topbar/>
                <div className="flex flex-1 overflow-hidden">
                    <AppSidebar/>
                    <main className="flex-1 overflow-auto">
                        <Outlet/>
                    </main>
                </div>
            </div>
            <TanStackRouterDevtools position="bottom-right"/>
        </>
    )
}
