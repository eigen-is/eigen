// The Sheets app's home: every sheet the viewer can open, in Drive's list and detail layout,
// with the selected one's ?pid=&uid=&mid= detail beside the list. EigenDocListView draws it.

import { createFileRoute } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocListView, SHEETS_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: () => <EigenDocListView config={SHEETS_CONFIG} route={Route} />,
    validateSearch: validateDriveSearch,
});
