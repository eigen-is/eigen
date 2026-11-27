// The Vector editor route: one drawing the URL names, opened through EigenDocEditorRoute. Its search names the open
// comments column (?panel= for its list, ?chat= for a thread), a card link (?card=) and a find-bar landing (?q=). The
// comment host reads the first three itself, and the route hands the editor the landing's search term. It sits outside
// the login guard, so a public link opens it with no login; the link guard sends a visitor of a private one to log in.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { VectorEditor } from '../components/vector/editor';

export const Route = createFileRoute('/vector/$ownerId/$mountId/$pathId')({
    beforeLoad: (match) => guardLinkRoute(match, match.params),
    component: VectorView,
    validateSearch: eigenDocEditorValidateSearch,
});

function VectorView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => <VectorEditor ownerId={ownerId} {...props} initialSearchTerm={initialSearchTerm} />}
        </EigenDocEditorRoute>
    );
}
