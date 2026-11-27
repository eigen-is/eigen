// Drive's inline view and editor of a text file. Closing it returns to the file's folder, or to Shared
// with me when the file was shared on its own and the viewer can't read that folder. A visitor without a
// login has no editor, so their public link lands on the file's Shared with me page, which guards it.

import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useBreadcrumb, usePathInfo } from '@workspace/lib/drive';
import { sharedChainHead } from '@workspace/lib/types/drive';
import { NativeFileEditor } from '../components/editor/native-file-editor';

export const Route = createFileRoute('/edit/$ownerId/$mountId/$pathId')({
    beforeLoad: ({ context, params: { ownerId, mountId, pathId } }) => {
        if (context.auth.user) return;
        throw redirect({
            to: '/shared/$to',
            params: { to: 'with-me' },
            search: { pid: pathId, uid: ownerId, mid: mountId },
        });
    },
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
