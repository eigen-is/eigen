// The Stickies board route: one board the URL names, opened through EigenDocEditorRoute. Its search names the open
// activity column (?panel=activity), the open card thread (?chat=), a card link (?card=), which becomes the card's
// ?chat= once the board loaded, and a find-bar landing (?q=). The board reads the first three itself, and the route
// hands it the landing's search term. It sits outside the login guard, so a public link opens it without a login; the
// link guard sends a visitor of a private one to log in.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/board/$ownerId/$mountId/$pathId')({
    beforeLoad: ({ context, location, params }) => guardLinkRoute(context, location, params),
    component: StickiesRoute,
    validateSearch: eigenDocEditorValidateSearch,
});

function StickiesRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);

    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => <StickiesBoard {...props} initialSearchTerm={initialSearchTerm} />}
        </EigenDocEditorRoute>
    );
}
