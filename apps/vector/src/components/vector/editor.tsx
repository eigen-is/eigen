import { useAuth } from '@workspace/lib/auth';
import { MediaResolverProvider } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { VECTOR_STYLE_DEFAULTS, type VectorElement } from '@workspace/lib/vector';
import { useLayout } from '@workspace/ui';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import {
    CanvasDocumentShell,
    CanvasEditor,
    type CanvasImageInsert,
    CanvasPropertiesPanel,
    CanvasToolbar,
    useCanvasCommentHost,
    useCanvasDoc,
    useCanvasDocSearch,
    useCanvasPresence,
    useSelection,
    useTool,
} from '@workspace/ui/components/vector';
import { Diamond } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
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
    initialChatName,
    initialSearchTerm,
}: VectorEditorProps) {
    const { isMobile } = useLayout();
    // Small screens view the scene, never edit it (the slides canEdit split: file menu, share and
    // comments keep canWrite); tablets sit above the breakpoint.
    const canEdit = canWrite && !isMobile;
    const doc = useCanvasDoc(ownerId, path.mountId, path.id, VECTOR_STYLE_DEFAULTS);
    const { tool, setTool, toolLocked, setToolLocked } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    // Awareness: publish this user's identity + selection, get a throttled cursor publisher for the
    // canvas. Selection is threaded from here (the editor owns selectedIds).
    const { user } = useAuth();
    // '' is the infinite canvas' frame: every peer publishes it, so every peer is visible.
    const publishCursor = useCanvasPresence(doc.provider, user, selectedIds, '');

    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    // Aspect lock, lifted here so the panel checkbox and the canvas' ObjectTransform
    // resizeMode share one ephemeral setting. Default ON for image-only selections.
    const allImageSelected = selectedElements.length > 0 && selectedElements.every((el) => el.type === 'image');
    const [aspectLocked, setAspectLocked] = useAspectLock(selectedIds.join(','), allImageSelected);

    // On the infinite canvas a reveal is just a selection — there is no slide to go to first.
    const revealElement = useCallback((el: VectorElement) => setSelectedIds([el.id]), [setSelectedIds]);

    const comments = useCanvasCommentHost({
        ownerId,
        path,
        canWrite,
        mediaFolderId,
        chatFolderId,
        initialChatName,
        doc,
        isMobile,
        onReveal: revealElement,
    });

    // ⌘F over the scene: a reveal selects the matching element (stable, or the controller churns).
    const {
        controller: docSearchController,
        matchedIds: searchMatchedIds,
        activeId: searchActiveId,
    } = useCanvasDocSearch({
        elements: doc.elements,
        frames: doc.frames,
        meta: doc.meta,
        onReveal: revealElement,
    });

    // Toolbar "Add image": the picker lives here, placement goes through the canvas' published
    // insert surface (placement needs the live viewport).
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const imageInsertRef = useRef<CanvasImageInsert | null>(null);

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <CanvasDocumentShell
                doc={doc}
                comments={comments}
                path={path}
                canWrite={canWrite}
                canEdit={canEdit}
                mediaFolderId={mediaFolderId}
                searchController={docSearchController}
                initialSearchTerm={initialSearchTerm}
                imagePickerOpen={imagePickerOpen}
                onImagePickerOpenChange={setImagePickerOpen}
                imageInsertRef={imageInsertRef}
                toolbar={
                    <CanvasToolbar
                        path={path}
                        canWrite={canWrite}
                        canEdit={canEdit}
                        offline={doc.offline}
                        storageUnavailable={doc.loaded && doc.storageUnavailable}
                        undoManager={doc.undoManager}
                        tool={tool}
                        setTool={setTool}
                        toolLocked={toolLocked}
                        setToolLocked={setToolLocked}
                        onInsertImage={canEdit && mediaFolderId ? () => setImagePickerOpen(true) : undefined}
                        onAccessDialogOpen={onAccessDialogOpen}
                        exportFormats={['svg', 'pdf']}
                        createLabel="New vector"
                        createIcon={Diamond}
                        createType="vector"
                        onToggleCommentPanel={comments.toggleComments}
                        commentPanelOpen={comments.commentPanelOpen}
                        assignedCommentCount={comments.assignedCount}
                        onToggleActivityPanel={comments.toggleActivity}
                        activityPanelOpen={comments.activityPanelOpen}
                    />
                }
                propertiesPanel={
                    <CanvasPropertiesPanel
                        elements={doc.elements}
                        selectedElements={selectedElements}
                        updateElements={doc.updateElements}
                        undoManager={doc.undoManager}
                        meta={doc.meta}
                        updateMeta={doc.updateMeta}
                        viewport="infinite"
                        aspectLocked={aspectLocked}
                        onAspectLockChange={setAspectLocked}
                    />
                }
            >
                <div className="flex-1 min-w-0">
                    <CanvasEditor
                        doc={doc}
                        viewport="infinite"
                        canEdit={canEdit}
                        ownerId={ownerId}
                        mountId={path.mountId}
                        tool={tool}
                        setTool={setTool}
                        toolLocked={toolLocked}
                        setToolLocked={setToolLocked}
                        selectedIds={selectedIds}
                        setSelectedIds={setSelectedIds}
                        toggle={toggle}
                        aspectLocked={aspectLocked}
                        publishCursor={publishCursor}
                        imageInsertRef={imageInsertRef}
                        onOpenCard={comments.openCard}
                        onAddComment={canWrite && chatFolderId ? comments.addCommentTo : undefined}
                        searchMatchedIds={searchMatchedIds}
                        searchActiveId={searchActiveId}
                    />
                </div>
            </CanvasDocumentShell>
        </MediaResolverProvider>
    );
}
