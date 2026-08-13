import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { DOCS_CONFIG, EigenDocSharedView, eigenDocValidateSearch } from '@workspace/ui/components/drive';

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
            config={DOCS_CONFIG}
            to={to}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: Route.fullPath, params: { to }, search })}
            onNavigateBack={() => navigate({ to: Route.fullPath, params: { to } })}
        />
    );
}
