// The Vector editor route: one drawing the URL names, opened through EigenDocEditorRoute. Its search names the open
// comment thread (?chat=) and a find-bar landing (?q=), and the editor takes both.

import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-latched-doc-search-term';
import { VectorEditor } from '../components/vector/editor';

export const Route = createFileRoute('/_auth/vector/$ownerId/$mountId/$pathId')({
    component: VectorView,
    validateSearch: eigenDocEditorValidateSearch,
});

function VectorView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { chat, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => <VectorEditor ownerId={ownerId} {...props} chat={chat} initialSearchTerm={initialSearchTerm} />}
        </EigenDocEditorRoute>
    );
}
