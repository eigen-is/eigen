import { useAuth } from '@workspace/lib/auth';
import { MediaResolverProvider } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import {
    useSelection,
    useTool,
    useVectorDoc,
    useVectorPresence,
    VectorCanvas,
    VectorPropertiesPanel,
} from '@workspace/ui/components/vector';
import { useMemo } from 'react';
import { Toolbar } from './toolbar';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};

// The live scene plus pointer/keyboard interaction. Tool and selection state are lifted here so the
// toolbar, canvas, and properties panel share one source (the slides editor/canvas idiom); viewport
// and gestures stay in the canvas. Wrapped in MediaResolverProvider (the slides idiom) so the canvas
// resolves + uploads images through the container's media/ folder.
export function VectorEditor({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
}: VectorEditorProps) {
    const doc = useVectorDoc(ownerId, path.mountId, path.id);
    const { tool, setTool } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    // Awareness: publish this user's identity + selection, get a throttled cursor publisher for the
    // canvas. Selection is threaded from here (the editor owns selectedIds).
    const { user } = useAuth();
    const publishCursor = useVectorPresence(doc.provider, user, selectedIds);

    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    const showPanel = canWrite && selectedElements.length > 0;

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <ColumnLayout>
                <Column
                    id="editor"
                    width="flex"
                    toolbarBorder="always"
                    toolbar={
                        <Toolbar
                            path={path}
                            canWrite={canWrite}
                            undoManager={doc.undoManager}
                            tool={tool}
                            setTool={setTool}
                            onAccessDialogOpen={onAccessDialogOpen}
                        />
                    }
                >
                    {!doc.synced ? (
                        <LoadingState />
                    ) : (
                        <div className="flex h-full w-full overflow-hidden">
                            <div className="flex-1 min-w-0">
                                <VectorCanvas
                                    elements={doc.elements}
                                    meta={doc.meta}
                                    tool={tool}
                                    setTool={setTool}
                                    canWrite={canWrite}
                                    addElement={doc.addElement}
                                    updateElement={doc.updateElement}
                                    updateElements={doc.updateElements}
                                    deleteElements={doc.deleteElements}
                                    duplicateElements={doc.duplicateElements}
                                    undoManager={doc.undoManager}
                                    selectedIds={selectedIds}
                                    setSelectedIds={setSelectedIds}
                                    toggle={toggle}
                                    provider={doc.provider}
                                    publishCursor={publishCursor}
                                />
                            </div>
                            {showPanel && (
                                <VectorPropertiesPanel
                                    elements={doc.elements}
                                    selectedElements={selectedElements}
                                    updateElements={doc.updateElements}
                                    undoManager={doc.undoManager}
                                />
                            )}
                        </div>
                    )}
                </Column>
            </ColumnLayout>
        </MediaResolverProvider>
    );
}
