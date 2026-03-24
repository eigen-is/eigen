import {createFileRoute} from '@tanstack/react-router';
import {EigenDocListView, eigenDocValidateSearch, STICKIES_CONFIG} from "@workspace/ui/components/layout/drive";

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: eigenDocValidateSearch,
});

function DriveRoute() {
    const {pid, mid} = Route.useSearch();
    return <EigenDocListView config={STICKIES_CONFIG} pid={pid} mid={mid}/>;
}
