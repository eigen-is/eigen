// The drawings shared by or with the viewer in the Vector app, with the selected one's ?pid=&uid=&mid=
// detail beside the list. EigenDocSharedView draws it.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocSharedView, VECTOR_CONFIG } from '@workspace/ui/components/drive';

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
            config={VECTOR_CONFIG}
            to={to}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: Route.fullPath, params: { to }, search })}
            onNavigateBack={() => navigate({ to: Route.fullPath, params: { to } })}
        />
    );
}
