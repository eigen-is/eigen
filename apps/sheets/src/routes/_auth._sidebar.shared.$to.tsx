// The sheets shared by or with the viewer in the Sheets app, with the selected one's ?pid=&uid=&mid=
// detail beside the list. EigenDocSharedView draws it.

import { createFileRoute } from '@tanstack/react-router';
import { validateDriveSearch } from '@workspace/lib/drive';
import { EigenDocSharedView, SHEETS_CONFIG } from '@workspace/ui/components/drive';

export const Route = createFileRoute('/_auth/_sidebar/shared/$to')({
    component: () => <EigenDocSharedView config={SHEETS_CONFIG} route={Route} />,
    validateSearch: validateDriveSearch,
});
