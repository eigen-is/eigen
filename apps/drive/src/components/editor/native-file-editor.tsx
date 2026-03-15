import {lazy, Suspense, useState} from "react";
import {EigenLoader} from "@workspace/ui";
import {editorKeys, useFileContent} from "@workspace/lib/editor";
import {useCheckWritePermission} from "@workspace/lib/drive";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useQueryClient} from "@tanstack/react-query";
import {Column, ColumnLayout} from "@workspace/ui/components/layout/app/column-layout";
import {DriveDetail, DriveDetailToolbar} from "@workspace/ui/components/layout/drive/drive-detail";
import {useLayout} from "@workspace/ui/components/layout/app/layout-context";
import {getDriveDownloadUrl} from "@workspace/lib/api";
import {ViewToolbar} from "./editor-toolbar";

const MarkdownEditor = lazy(() => import("./markdown-editor").then(m => ({default: m.MarkdownEditor})));
const CodeEditor = lazy(() => import("./code-editor").then(m => ({default: m.CodeEditor})));
const MarkdownViewer = lazy(() => import("./markdown-editor").then(m => ({default: m.MarkdownViewer})));
const CodeViewer = lazy(() => import("./code-editor").then(m => ({default: m.CodeViewer})));

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

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <EigenLoader/>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex items-center justify-center h-full w-full">
                <p className="text-muted-foreground">{error?.message || 'Failed to load file'}</p>
            </div>
        );
    }

    const updatedAt = data.updatedAt instanceof Date ? data.updatedAt.toISOString() : String(data.updatedAt);
    const editorProps = {
        key: reloadKey,
        content: data.content,
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

    const detailColumn = !isMobile && (
        <Column id="detail" width="400px"
                toolbar={<DriveDetailToolbar path={path} onDownload={handleDownload} allowDelete={false}/>}>
            <DriveDetail path={path} onDownload={handleDownload}/>
        </Column>
    );

    if (!editing) {
        const viewToolbar = <ViewToolbar path={path} canWrite={canWrite} onEdit={() => setEditing(true)} onClose={onClose}/>;
        return (
            <ColumnLayout>
                <Column id="list" width="flex" toolbar={viewToolbar}>
                    <Suspense fallback={<div className="flex items-center justify-center h-full"><EigenLoader/></div>}>
                        {data.editMode === 'markdown' ? (
                            <MarkdownViewer key={reloadKey} content={data.content}/>
                        ) : (
                            <CodeViewer key={reloadKey} content={data.content} fileName={path.name}/>
                        )}
                    </Suspense>
                </Column>
                {detailColumn}
            </ColumnLayout>
        );
    }

    return (
        <ColumnLayout>
            <Suspense fallback={<div className="flex items-center justify-center h-full w-full"><EigenLoader/></div>}>
                {data.editMode === 'markdown' ? (
                    <MarkdownEditor {...editorProps} frontmatter={data.frontmatter ?? null}/>
                ) : (
                    <CodeEditor {...editorProps}/>
                )}
            </Suspense>
            {detailColumn}
        </ColumnLayout>
    );
}
