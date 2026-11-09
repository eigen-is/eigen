// The boards shared by or with the viewer in the Stickies app, with the selected one's ?pid=&uid=&mid=
// detail beside the list. EigenDocSharedView draws it.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocSharedView, STICKIES_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/shared/$to')({
    component: SharedRoute,
    validateSearch: validateDriveSearch,
});

function SharedRoute() {
    const { to } = Route.useParams();
    const { pid, uid, mid } = Route.useSearch();
    const navigate = useNavigate();
    return (
        <EigenDocSharedView
            config={STICKIES_CONFIG}
            to={to}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: Route.fullPath, params: { to }, search })}
            onNavigateBack={() => navigate({ to: Route.fullPath, params: { to } })}
        />
    );
}
