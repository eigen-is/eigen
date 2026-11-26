// The Stickies board route: one board the URL names, opened through EigenDocEditorRoute. Its search names the open
// activity column (?panel=activity), the open card thread (?chat=), a card link (?card=), which becomes the card's
// ?chat= once the board loaded, and a find-bar landing (?q=). The board reads the first three itself, and the route
// hands it the landing's search term.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { StickiesBoard } from '../components/stickies/board';

export const Route = createFileRoute('/_auth/board/$ownerId/$mountId/$pathId')({
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
