// The route of one open doc. It renders the Docs editor inside the shared editor route, which loads the document and
// shows its status, and threads in the comment a ?chat= link names and the find bar's ?q=. It sits outside the login
// guard, so a public link opens it without a login: the link guard sends a visitor of a private doc to log in.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { guardLinkRoute } from '@workspace/ui/components/layout/pages';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { CollaborativeEditor } from '../components/docs/editor';

export const Route = createFileRoute('/doc/$ownerId/$mountId/$pathId')({
    beforeLoad: ({ context, location, params }) => guardLinkRoute(context, location, params),
    component: CollaborativeTextEditor,
    validateSearch: eigenDocEditorValidateSearch,
});

function CollaborativeTextEditor() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => (
                <div className="flex-1 overflow-hidden">
                    <CollaborativeEditor {...props} initialChatName={chat} initialSearchTerm={initialSearchTerm} />
                </div>
            )}
        </EigenDocEditorRoute>
    );
}
