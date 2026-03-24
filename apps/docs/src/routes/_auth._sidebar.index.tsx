import {createFileRoute} from '@tanstack/react-router';
import {DOCS_CONFIG, EigenDocListView, eigenDocValidateSearch} from "@workspace/ui/components/layout/drive";

export const Route = createFileRoute('/_auth/_sidebar/')({
    component: DriveRoute,
    validateSearch: eigenDocValidateSearch,
});

function DriveRoute() {
    const {pid, mid} = Route.useSearch();
    return <EigenDocListView config={DOCS_CONFIG} pid={pid} mid={mid}/>;
}
