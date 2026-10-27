// Drive's inline view and editor of a text file. Closing it returns to the file's folder, or to Shared
// with me when the file was shared on its own and the viewer can't read that folder.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useBreadcrumb, usePathInfo } from '@workspace/lib/drive';
import { sharedChainHead } from '@workspace/lib/types/drive';
import { NativeFileEditor } from '../components/editor/native-file-editor';

export const Route = createFileRoute('/_auth/edit/$ownerId/$mountId/$pathId')({
    component: EditRoute,
});

function EditRoute() {
    const { ownerId, mountId, pathId } = Route.useParams();
    const navigate = useNavigate();
    const { data: path } = usePathInfo(ownerId, mountId, pathId);
    // The file heads its own chain when the viewer can't read its folder, as the crumb above it shows.
    const { data: crumbs = [] } = useBreadcrumb(ownerId, mountId, pathId);

    if (!path) return null;

    const handleClose = () => {
        if (sharedChainHead(crumbs)?.id === path.id) {
            navigate({ to: '/shared/$to', params: { to: 'with-me' } });
        } else {
            navigate({
                to: '/fs/$ownerId/$mountId/$pathId',
                params: { ownerId, mountId, pathId: path.parentId ?? 'root' },
            });
        }
    };

    return <NativeFileEditor path={path} onClose={handleClose} />;
}
