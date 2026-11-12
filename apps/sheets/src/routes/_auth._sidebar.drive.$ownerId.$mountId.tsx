// The sheets on one team drive in the Sheets app. The list spans that one mount, so Move to works here,
// and the selected one's ?pid=&uid=&mid= opens its detail beside it. EigenDocListView draws it.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocListView, SHEETS_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/drive/$ownerId/$mountId')({
    component: TeamDriveRoute,
    validateSearch: validateDriveSearch,
});

function TeamDriveRoute() {
    const { ownerId, mountId } = Route.useParams();
    const { pid, uid, mid } = Route.useSearch();
    const navigate = useNavigate();
    const { user } = Route.useRouteContext();
    return (
        <EigenDocListView
            config={SHEETS_CONFIG}
            viewerId={user.id}
            ownerId={ownerId}
            mountId={mountId}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: Route.fullPath, params: { ownerId, mountId }, search })}
            onNavigateBack={() => navigate({ to: Route.fullPath, params: { ownerId, mountId } })}
        />
    );
}
