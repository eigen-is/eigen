// The vector editor: one infinite canvas with its toolbar, properties panel and comments. Tool and selection state
// live here, so the toolbar, the canvas and the panel share them, while the viewport and the gestures stay in the
// canvas. The vector route renders it for one vector file.

import { useAuth } from '@workspace/lib/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { VectorElement } from '@workspace/lib/vector';
import { VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { useLayout } from '@workspace/ui/components/layout/app';
import { ColorRow, PropertySection, useAspectLock } from '@workspace/ui/components/properties-panel';
import type { CanvasHandle } from '@workspace/ui/components/vector';
import {
    CanvasDocumentShell,
    CanvasEditor,
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
    // A phone views the scene and never edits it, as in slides. The file menu, sharing and comments still follow
    // canWrite. A tablet sits above the breakpoint, so it edits.
    const canEdit = canWrite && !isMobile;
    const doc = useCanvasDoc(ownerId, path.mountId, path.id, VECTOR_STYLE_DEFAULTS);
    const { tool, setTool, toolLocked, setToolLocked } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    // The canvas reports an open text editor, so the toolbar's Edit rows stand down as the canvas's keys do.
    const [textEditing, setTextEditing] = useState(false);
    // Peers see this user's name and selection, and the canvas gets a throttled publisher for the cursor. The selection
    // comes from here, because the editor owns it.
    const { user } = useAuth();
    // '' is the infinite canvas' frame: every peer publishes it, so every peer is visible.
    const publishCursor = useCanvasPresence(doc.provider, user, selectedIds, '');

    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    // The aspect lock lives here, so the panel's checkbox and the canvas' resize handles share one setting. It starts on
    // when only images are selected.
    const allImageSelected = selectedElements.length > 0 && selectedElements.every((el) => el.type === 'image');
    const [aspectLocked, setAspectLocked] = useAspectLock(selectedIds, allImageSelected);

    const canvasRef = useRef<CanvasHandle | null>(null);

    // A reveal, such as a ⌘F match or a comment card, selects the element and brings it to the center. The infinite
    // canvas has no slide to go to first, but the element may sit anywhere.
    const revealElement = useCallback(
        (el: VectorElement) => {
            setSelectedIds([el.id]);
            canvasRef.current?.centerOn(el);
        },
        [setSelectedIds],
    );

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
    const addComment = canWrite && chatFolderId ? comments.addCommentTo : undefined;

    // ⌘F over the scene: a reveal selects the matching element. The reveal keeps its identity, or the controller would
    // start over on every render.
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

    // The toolbar's Add image opens the picker here, and the canvas handle places what was picked.
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const insertImage = canEdit && mediaFolderId ? () => setImagePickerOpen(true) : undefined;

    return (
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
            canvasRef={canvasRef}
            toolbar={
                <CanvasToolbar
                    path={path}
                    canWrite={canWrite}
                    canEdit={canEdit}
                    offline={doc.offline}
                    storageUnavailable={doc.storageUnavailable}
                    undoManager={doc.undoManager}
                    tool={tool}
                    setTool={setTool}
                    selectedIds={selectedIds}
                    textEditing={textEditing}
                    toolLocked={toolLocked}
                    setToolLocked={setToolLocked}
                    onInsertImage={insertImage}
                    onAddComment={addComment}
                    canvasRef={canvasRef}
                    onAccessDialogOpen={onAccessDialogOpen}
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
                    reorderElements={doc.reorderElements}
                    replaceElement={doc.replaceElement}
                    setSelectedIds={setSelectedIds}
                    undoManager={doc.undoManager}
                    aspectLocked={aspectLocked}
                    onAspectLockChange={setAspectLocked}
                    emptySection={
                        <PropertySection title="Background">
                            {/* The scene background is a plain color, not a frame's Fill. Transparent is the default
                                and draws as such, so None is the way back from a color. */}
                            <ColorRow
                                label="Color"
                                value={doc.meta.background}
                                onChange={(c) => doc.updateMeta({ background: c })}
                                allowNone
                            />
                        </PropertySection>
                    }
                />
            }
        >
            <div className="flex-1 min-w-0">
                <CanvasEditor
                    doc={doc}
                    styleDefaults={VECTOR_STYLE_DEFAULTS}
                    viewport="infinite"
                    canEdit={canEdit}
                    ownerId={ownerId}
                    mountId={path.mountId}
                    fileName={path.name}
                    tool={tool}
                    setTool={setTool}
                    toolLocked={toolLocked}
                    setToolLocked={setToolLocked}
                    selectedIds={selectedIds}
                    setSelectedIds={setSelectedIds}
                    toggle={toggle}
                    aspectLocked={aspectLocked}
                    publishCursor={publishCursor}
                    canvasRef={canvasRef}
                    onTextEditingChange={setTextEditing}
                    onOpenCard={comments.openCard}
                    commentCards={comments.lifecycle.cards}
                    onAddComment={addComment}
                    onCommentHover={comments.onCommentHover}
                    searchMatchedIds={searchMatchedIds}
                    searchActiveId={searchActiveId}
                    onInsertImage={insertImage}
                />
            </div>
        </CanvasDocumentShell>
    );
}
