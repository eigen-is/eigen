// The Docs editor route: one doc the URL names, opened through EigenDocEditorRoute. Its search names the open
// comments column (?panel= for its list, ?chat= for a thread) and a find-bar landing (?q=), and the editor takes them.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { CollaborativeEditor } from '../components/docs/editor';

export const Route = createFileRoute('/_auth/doc/$ownerId/$mountId/$pathId')({
    component: CollaborativeTextEditor,
    validateSearch: eigenDocEditorValidateSearch,
});

function CollaborativeTextEditor() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, panel, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => (
                <div className="flex-1 overflow-hidden">
                    <CollaborativeEditor {...props} panel={panel} chat={chat} initialSearchTerm={initialSearchTerm} />
                </div>
            )}
        </EigenDocEditorRoute>
    );
}
