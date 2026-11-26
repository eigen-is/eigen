// The Slides editor route: one deck the URL names, opened through EigenDocEditorRoute. Its search names the open
// comments column (?panel= for its list, ?chat= for a thread), a card link (?card=) and a find-bar landing (?q=), and
// the editor takes them.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { SlideEditor } from '../components/slides/editor';

export const Route = createFileRoute('/_auth/slide/$ownerId/$mountId/$pathId')({
    component: SlideView,
    validateSearch: eigenDocEditorValidateSearch,
});

function SlideView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, card, panel, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => (
                <SlideEditor
                    ownerId={ownerId}
                    {...props}
                    panel={panel}
                    chat={chat}
                    card={card}
                    initialSearchTerm={initialSearchTerm}
                />
            )}
        </EigenDocEditorRoute>
    );
}
