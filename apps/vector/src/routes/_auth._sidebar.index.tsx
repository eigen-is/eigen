import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { EigenDocListView, eigenDocValidateSearch, VECTOR_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: eigenDocValidateSearch,
});

function DriveRoute() {
    const { pid, uid, mid } = Route.useSearch();
    const navigate = useNavigate();
    return (
        <EigenDocListView
            config={VECTOR_CONFIG}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: '/', search })}
            onNavigateBack={() => navigate({ to: '/' })}
        />
    );
}
