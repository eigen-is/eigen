import { useQueryClient } from '@tanstack/react-query';
import { getDriveDownloadUrl } from '@workspace/lib/api';
import { useCheckPermissions, useTextPreview } from '@workspace/lib/drive';
import { invalidateEditorContent, useFileContent } from '@workspace/lib/editor';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, ErrorState, LoadingState, useLayout } from '@workspace/ui';
import { DriveDetail, DriveDetailToolbar } from '@workspace/ui/components/drive/drive-detail';
import { lazy, Suspense, useState } from 'react';
import { ViewToolbar } from './editor-toolbar';

const MarkdownEditor = lazy(() => import('./markdown-editor').then((m) => ({ default: m.MarkdownEditor })));
const CodeEditor = lazy(() => import('./code-editor').then((m) => ({ default: m.CodeEditor })));

type NativeFileEditorProps = {
    path: DrivePath;
    onClose: () => void;
};

export function NativeFileEditor({ path, onClose }: NativeFileEditorProps) {
    const [editing, setEditing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const { data, isLoading, error } = useFileContent(path.ownerId, path.mountId, path.id);
    const { data: permissions } = useCheckPermissions(path.ownerId, path.mountId, path.id);
    const canWrite = permissions?.canWrite ?? false;
    const queryClient = useQueryClient();
    const { isMobile } = useLayout();
    const { data: preview } = useTextPreview(path.ownerId, path.mountId, path.id, path.updatedAt, !editing);

    const handleReload = () => {
        invalidateEditorContent(queryClient, path.ownerId, path.mountId, path.id);
        setReloadKey((k) => k + 1);
        setEditing(false);
    };

    const exitEditMode = () => {
        setReloadKey((k) => k + 1);
        setEditing(false);
    };

    const handleDownload = () => {
        const url = getDriveDownloadUrl(path.ownerId, path.mountId, path.id, path.updatedAt);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    if (isLoading && !preview) {
        return <LoadingState />;
    }

    if (error || (!data && !preview)) {
        return <ErrorState detail={error?.message || 'Failed to load file'} />;
    }

    const detailColumn = !isMobile && (
        <Column id="detail" width="400px" toolbar={<DriveDetailToolbar />}>
            <DriveDetail path={path} onDownload={handleDownload} />
        </Column>
    );

    if (!editing) {
        const viewToolbar = (
            <ViewToolbar path={path} canWrite={canWrite && !!data} onEdit={() => setEditing(true)} onClose={onClose} />
        );
        return (
            <ColumnLayout>
                <Column id="list" width="flex" onBack={onClose} toolbar={viewToolbar}>
                    <div className="h-full overflow-auto">
                        <div className="w-full px-12 py-6 max-w-[52rem] mx-auto">
                            {preview?.body ? (
                                <div className="eigen-prose" dangerouslySetInnerHTML={{ __html: preview.body }} />
                            ) : (
                                <LoadingState />
                            )}
                        </div>
                    </div>
                </Column>
                {detailColumn}
            </ColumnLayout>
        );
    }

    if (!data) return <LoadingState />;

    const updatedAt = data.updatedAt;
    const editorProps = {
        content: data.content,
        updatedAt,
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        fileName: path.name,
        canWrite,
        onBack: onClose,
        onCancel: exitEditMode,
        onSaved: exitEditMode,
        onReload: handleReload,
    };

    return (
        <ColumnLayout>
            {/* The editor returns a find-bar provider wrapping its Column; this grows it in the row. */}
            <div className="flex-1 min-w-0 h-full">
                <Suspense fallback={<LoadingState />}>
                    {data.editMode === 'markdown' ? (
                        <MarkdownEditor key={reloadKey} {...editorProps} frontmatter={data.frontmatter ?? null} />
                    ) : (
                        <CodeEditor key={reloadKey} {...editorProps} />
                    )}
                </Suspense>
            </div>
            {detailColumn}
        </ColumnLayout>
    );
}
