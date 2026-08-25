import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { EigenDocSharedView, eigenDocValidateSearch, VECTOR_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/shared/$to')({
    component: SharedRoute,
    validateSearch: eigenDocValidateSearch,
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
