// Sheets' root route. It hands EigenDocRoot the Sheets config and two things the URL knows: whether a sheet
// is open, which hides the sidebar so the editor fills the page, and which team drive is open, so New
// creates there and not in the user's own drive.

import { createRootRouteWithContext, useMatch } from '@tanstack/react-router';
import type { RouterAppContext } from '@workspace/lib/types/auth';
import { EigenDocRoot, SHEETS_CONFIG } from '@workspace/ui/components/drive';

function SheetsRoot() {
    const isEditorRoute = useMatch({ from: '/_auth/sheet/$ownerId/$mountId/$pathId', shouldThrow: false });
    const teamDriveMatch = useMatch({ from: '/_auth/_sidebar/drive/$ownerId/$mountId', shouldThrow: false });
    return (
        <EigenDocRoot
            config={SHEETS_CONFIG}
            rootRoute={Route}
            isFullScreen={!!isEditorRoute}
            teamOwnerId={teamDriveMatch?.params.ownerId}
            teamMountId={teamDriveMatch?.params.mountId}
        />
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: SheetsRoot,
});
