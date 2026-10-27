// The toolbars of Drive's inline text view: the view toolbar with the file's crumbs and an Edit
// button, and the edit toolbar with back, find, Cancel and Save. The crumbs are the folder list's own,
// read from the file's chain, so a file opened from Shared with me, a team drive or search reads the
// same path its folder would.

import { useNavigate } from '@tanstack/react-router';
import { useBreadcrumb } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Toolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { useMountLabel } from '@workspace/ui/components/drive';
import { DriveBreadcrumb } from '@workspace/ui/components/drive/drive-breadcrumb';
import { FindInDocumentButton } from '@workspace/ui/components/search/find-in-document-button';
import { ArrowLeft } from 'lucide-react';

type ViewToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    onEdit: () => void;
};

export function ViewToolbar({ path, canWrite, onEdit }: ViewToolbarProps) {
    const navigate = useNavigate();
    // The file's own chain, not its folder's: a file shared on its own has a folder the viewer can't read.
    const { data: breadcrumbPaths = [] } = useBreadcrumb(path.ownerId, path.mountId, path.id);
    const mountLabel = useMountLabel(path.ownerId, path.mountId);

    const handleBreadcrumbClick = (folder: DrivePath) => {
        navigate({
            to: '/fs/$ownerId/$mountId/$pathId',
            params: { ownerId: folder.ownerId, mountId: folder.mountId, pathId: folder.id },
        });
    };

    const handleOpenSharedWithMe = () => {
        navigate({ to: '/shared/$to', params: { to: 'with-me' } });
    };

    return (
        <Toolbar>
            <DriveBreadcrumb
                paths={breadcrumbPaths}
                mountLabel={mountLabel}
                onNavigate={handleBreadcrumbClick}
                onOpenSharedWithMe={handleOpenSharedWithMe}
            />
            {canWrite && (
                <Button size="sm" onClick={onEdit}>
                    Edit
                </Button>
            )}
        </Toolbar>
    );
}

type EditToolbarProps = {
    onBack: () => void;
    onCancel: () => void;
    onSave: () => void;
    isSaving: boolean;
    children?: React.ReactNode;
};

export function EditToolbar({ onBack, onCancel, onSave, isSaving, children }: EditToolbarProps) {
    return (
        <Toolbar>
            <div className="flex items-center gap-1">
                <TooltipButton icon={ArrowLeft} tooltipText="Back to files" onClick={onBack} />
                {children}
                <FindInDocumentButton />
            </div>
            <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={onCancel}>
                    Cancel
                </Button>
                <Button size="sm" disabled={isSaving} onClick={onSave}>
                    {isSaving ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </Toolbar>
    );
}
