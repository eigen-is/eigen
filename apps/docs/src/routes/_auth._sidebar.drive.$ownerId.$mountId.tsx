// The docs on one team drive in the Docs app. The list spans that one mount, so Move to works here,
// and the selected one's ?pid=&uid=&mid= opens its detail beside it. EigenDocListView draws it.

import { createFileRoute } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { DOCS_CONFIG, EigenDocListView } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/drive/$ownerId/$mountId')({
    component: () => <EigenDocListView config={DOCS_CONFIG} route={Route} />,
    validateSearch: validateDriveSearch,
});
