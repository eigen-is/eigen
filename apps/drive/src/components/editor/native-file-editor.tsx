import {lazy, Suspense, useState} from "react";
import {ErrorState, LoadingState} from "@workspace/ui";
import {editorKeys, useFileContent} from "@workspace/lib/editor";
import {useCheckWritePermission, useTextPreview} from "@workspace/lib/drive";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useQueryClient} from "@tanstack/react-query";
import {Column, ColumnLayout} from "@workspace/ui/components/layout/app/column-layout";
import {DriveDetail, DriveDetailToolbar} from "@workspace/ui/components/layout/drive/drive-detail";
import {useLayout} from "@workspace/ui/components/layout/app/layout-context";
import {getDriveDownloadUrl} from "@workspace/lib/api";
import {ViewToolbar} from "./editor-toolbar";

const MarkdownEditor = lazy(() => import("./markdown-editor").then(m => ({default: m.MarkdownEditor})));
const CodeEditor = lazy(() => import("./code-editor").then(m => ({default: m.CodeEditor})));

type NativeFileEditorProps = {
    path: DrivePath;
    onClose: () => void;
};

export function NativeFileEditor({path, onClose}: NativeFileEditorProps) {
    const [editing, setEditing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const {data, isLoading, error} = useFileContent(path.ownerId, path.mountId, path.id);
    const {data: writePermission} = useCheckWritePermission(path.ownerId, path.mountId, path.id);
    const canWrite = writePermission?.canWrite ?? false;
    const queryClient = useQueryClient();
    const {isMobile} = useLayout();
    const {data: preview} = useTextPreview(path.ownerId, path.mountId, path.id, !editing);

    const handleReload = () => {
        queryClient.invalidateQueries({queryKey: editorKeys.content(path.ownerId, path.mountId, path.id)});
        setReloadKey(k => k + 1);
        setEditing(false);
    };

    const exitEditMode = () => {
        setReloadKey(k => k + 1);
        setEditing(false);
    };

    const handleDownload = () => {
        const url = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    if (isLoading && !preview) {
        return <LoadingState/>;
    }

    if (error || (!data && !preview)) {
        return <ErrorState detail={error?.message || 'Failed to load file'}/>;
    }

    const detailColumn = !isMobile && (
        <Column id="detail" width="400px"
                toolbar={<DriveDetailToolbar path={path} onDownload={handleDownload} allowDelete={false}/>}>
            <DriveDetail path={path} onDownload={handleDownload}/>
        </Column>
    );

    if (!editing) {
        const viewToolbar = <ViewToolbar path={path} canWrite={canWrite && !!data} onEdit={() => setEditing(true)} onClose={onClose}/>;
        return (
            <ColumnLayout>
                <Column id="list" width="flex" toolbar={viewToolbar}>
                    <div className="h-full overflow-auto">
                        <div className="w-full px-12 py-6 max-w-[52rem] mx-auto">
                            {preview?.body ? (
                                <div className="eigen-prose" dangerouslySetInnerHTML={{__html: preview.body}}/>
                            ) : (
                                <LoadingState/>
                            )}
                        </div>
                    </div>
                </Column>
                {detailColumn}
            </ColumnLayout>
        );
    }

    const updatedAt = data!.updatedAt instanceof Date ? data!.updatedAt.toISOString() : String(data!.updatedAt);
    const editorProps = {
        key: reloadKey,
        content: data!.content,
        updatedAt,
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        fileName: path.name,
        onBack: onClose,
        onCancel: exitEditMode,
        onSaved: exitEditMode,
        onReload: handleReload,
    };

    return (
        <ColumnLayout>
            <Suspense fallback={<LoadingState/>}>
                {data!.editMode === 'markdown' ? (
                    <MarkdownEditor {...editorProps} frontmatter={data!.frontmatter ?? null}/>
                ) : (
                    <CodeEditor {...editorProps}/>
                )}
            </Suspense>
            {detailColumn}
        </ColumnLayout>
    );
}
