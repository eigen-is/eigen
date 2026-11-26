// The Sheets editor route: one workbook the URL names, opened through EigenDocEditorRoute. Its search names the open
// comments column (?panel= for its list, ?chat= for a thread), a card link (?card=) and a find-bar landing (?q=). The
// comment host reads the first three itself, and the route hands the editor the landing's search term. It sits outside
// the login guard, so a public link opens it without a login; the link guard sends a visitor of a private one to log
// in.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { SheetEditor } from '../components/sheets/editor';

export const Route = createFileRoute('/sheet/$ownerId/$mountId/$pathId')({
    beforeLoad: ({ context, location, params }) => guardLinkRoute(context, location, params),
    component: SheetView,
    validateSearch: eigenDocEditorValidateSearch,
});

function SheetView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => <SheetEditor {...props} initialSearchTerm={initialSearchTerm} />}
        </EigenDocEditorRoute>
    );
}
