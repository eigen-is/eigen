// The drawings on one team drive in the Vector app. The list spans that one mount, so Move to works here,
// and the selected one's ?pid=&uid=&mid= opens its detail beside it. EigenDocListView draws it.

import { createFileRoute } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocListView, VECTOR_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/drive/$ownerId/$mountId')({
    component: () => <EigenDocListView config={VECTOR_CONFIG} route={Route} />,
    validateSearch: validateDriveSearch,
});
