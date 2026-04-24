import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { DOCS_CONFIG, EigenDocListView, eigenDocValidateSearch } from '@workspace/ui/components/layout/drive';

export const Route = createFileRoute('/_auth/_sidebar/drive/$ownerId/$mountId')({
    component: TeamDriveRoute,
    validateSearch: eigenDocValidateSearch,
});

function TeamDriveRoute() {
    const { ownerId, mountId } = Route.useParams();
    const { pid, mid } = Route.useSearch();
    const navigate = useNavigate();
    return (
        <EigenDocListView
            config={DOCS_CONFIG}
            ownerId={ownerId}
            mountId={mountId}
            pid={pid}
            mid={mid}
            onNavigate={(search) => navigate({ to: Route.fullPath, params: { ownerId, mountId }, search })}
            onNavigateBack={() => navigate({ to: Route.fullPath, params: { ownerId, mountId } })}
        />
    );
}
