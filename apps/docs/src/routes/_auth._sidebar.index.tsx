// The Docs app's home: every doc the viewer can open, in Drive's list and detail layout,
// with the selected one's ?pid=&uid=&mid= detail beside the list. EigenDocListView draws it.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { DOCS_CONFIG, EigenDocListView } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: validateDriveSearch,
});

function DriveRoute() {
    const { pid, uid, mid } = Route.useSearch();
    const navigate = useNavigate();
    return (
        <EigenDocListView
            config={DOCS_CONFIG}
            pid={pid}
            uid={uid}
            mid={mid}
            onNavigate={(search) => navigate({ to: '/', search })}
            onNavigateBack={() => navigate({ to: '/' })}
        />
    );
}
