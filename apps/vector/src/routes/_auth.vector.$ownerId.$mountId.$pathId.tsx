import { createFileRoute } from '@tanstack/react-router';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { EigenDocEditorRoute } from '@workspace/ui/components/layout/app/eigen-doc-editor-route';
import { useLatchedDocSearchTerm } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { VectorEditor } from '../components/vector/editor';

export const Route = createFileRoute('/_auth/vector/$ownerId/$mountId/$pathId')({
    component: VectorView,
    validateSearch: eigenDocEditorValidateSearch,
});

function VectorView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    // ?chat=<chatName> deep-links straight to a comment thread, ?q= lands in the find bar (both
    // validated by eigenDocEditorValidateSearch).
    const { chat, q } = Route.useSearch();
    const initialSearchTerm = useLatchedDocSearchTerm(q);
    return (
        <EigenDocEditorRoute ownerId={ownerId} mountId={mountId} pathId={pathId}>
            {(props) => (
                <VectorEditor
                    ownerId={ownerId}
                    {...props}
                    initialChatName={chat}
                    initialSearchTerm={initialSearchTerm}
                />
            )}
        </EigenDocEditorRoute>
    );
}
