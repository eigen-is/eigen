import { createFileRoute } from '@tanstack/react-router';
import { LoadingState, RequestAccessView } from '@workspace/ui';
import { eigenDocEditorValidateSearch } from '@workspace/ui/components/drive';
import { useEigenDocEditorRoute } from '@workspace/ui/hooks/use-eigen-doc-editor-route';
import { VectorEditor } from '../components/vector/editor';

export const Route = createFileRoute('/_auth/vector/$ownerId/$mountId/$pathId')({
    component: VectorView,
    validateSearch: eigenDocEditorValidateSearch,
});

// The sibling editor routes also mount DriveAccessDialog; that returns here once the
// real editor has a share button to open it (the placeholder shell has none).
function VectorView() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const { docInfo, isLoading, path } = useEigenDocEditorRoute(ownerId, mountId, pathId);

    if (isLoading) return <LoadingState />;
    if (!docInfo?.canRead || !path) return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId} />;

    return <VectorEditor path={path} />;
}
