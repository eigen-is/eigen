// The Sheets app's home: every sheet the viewer can open, in Drive's list and detail layout,
// with the selected one's ?pid=&uid=&mid= detail beside the list. EigenDocListView draws it.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocListView, SHEETS_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: validateDriveSearch,
});

function DriveRoute() {
    const { pid, uid, mid } = Route.useSearch();
    const navigate = useNavigate();
    const { user } = Route.useRouteContext();
    return (
        <EigenDocListView
            config={SHEETS_CONFIG}
            viewerId={user.id}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: '/', search })}
            onNavigateBack={() => navigate({ to: '/' })}
        />
    );
}
