import { useBreadcrumb } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { Toolbar, TooltipButton } from '@workspace/ui';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Button } from '@workspace/ui/components/button';
import { FindInDocumentButton } from '@workspace/ui/components/search/find-in-document-button';
import { ArrowLeft } from 'lucide-react';
import { Fragment } from 'react';

type ViewToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    onEdit: () => void;
    onClose: () => void;
};

export function ViewToolbar({ path, canWrite, onEdit, onClose }: ViewToolbarProps) {
    const { data: breadcrumbPaths = [] } = useBreadcrumb(path.ownerId, path.mountId, path.parentId ?? undefined);

    return (
        <Toolbar>
            <div className="flex items-center gap-1 overflow-hidden">
                <Breadcrumb className="overflow-hidden">
                    <BreadcrumbList>
                        {breadcrumbPaths.map((p, index) => (
                            <Fragment key={p.id}>
                                {index > 0 && <BreadcrumbSeparator />}
                                <BreadcrumbItem>
                                    <BreadcrumbLink onClick={onClose} className="cursor-pointer">
                                        {stripEigenExtension(p.name)}
                                    </BreadcrumbLink>
                                </BreadcrumbItem>
                            </Fragment>
                        ))}
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                            <BreadcrumbPage>{stripEigenExtension(path.name)}</BreadcrumbPage>
                        </BreadcrumbItem>
                    </BreadcrumbList>
                </Breadcrumb>
            </div>
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
