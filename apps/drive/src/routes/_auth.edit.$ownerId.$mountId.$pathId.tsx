import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { usePathInfo } from '@workspace/lib/drive';
import { NativeFileEditor } from '../components/editor/native-file-editor';

export const Route = createFileRoute('/_auth/edit/$ownerId/$mountId/$pathId')({
    component: EditRoute,
});

function EditRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const navigate = useNavigate();
    const { data: path } = usePathInfo(ownerId, mountId, pathId);

    if (!path) return null;

    const handleClose = () => {
        const parentId = path.parentId;
        if (parentId) {
            navigate({ to: '/fs/$ownerId/$mountId/$pathId', params: { ownerId, mountId, pathId: parentId } });
        } else {
            navigate({ to: '/fs/$ownerId/$mountId/$pathId', params: { ownerId, mountId, pathId: 'root' } });
        }
    };

    return <NativeFileEditor path={path} onClose={handleClose} />;
}
