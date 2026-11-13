// The decks on one team drive in the Slides app. The list spans that one mount, so Move to works here,
// and the selected one's ?pid=&uid=&mid= opens its detail beside it. EigenDocListView draws it.

import { createFileRoute } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocListView, SLIDES_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/drive/$ownerId/$mountId')({
    component: () => <EigenDocListView config={SLIDES_CONFIG} route={Route} />,
    validateSearch: validateDriveSearch,
});
