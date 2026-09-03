import { useAuth } from '@workspace/lib/auth';
import { useCommentCards, useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { MediaResolverProvider } from '@workspace/lib/drive';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { elementForCommentCard, parseIdList, serializeIdList, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { CollabLoadingState, Column, ColumnLayout, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import { type CommentContextMenuItem, CommentLifecycleDialogs, PanelColumn } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import {
    CanvasEditor,
    type CanvasImageInsert,
    CanvasPropertiesPanel,
    useCanvasComments,
    useCanvasDoc,
    useCanvasDocSearch,
    useCanvasPresence,
    useSelection,
    useTool,
} from '@workspace/ui/components/vector';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Toolbar } from './toolbar';

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

    // Comments + activity (the slides PanelColumn shape). Read the cards here so the "active" set is
    // derived independently of the lifecycle's own card read (the slides idiom). A card anchored to an
    // element takes that element's text as its panel row; every card stays active either way — one whose
    // element was deleted degrades to document-level rather than vanishing.
    const cards = useCommentCards(doc.yjsDoc, 'comments');
    const activeComments = useCanvasComments(doc.elements, cards);

    const {
        panel,
        commentPanelOpen,
        activityPanelOpen,
        mobilePanelOpen,
        toggleComments,
        toggleActivity,
        closePanels,
        onSearchOpenChange,
    } = useDocumentPanels(isMobile);

    // ⌘F over the scene: a reveal selects the matching element (stable, or the controller churns).
    const {
        controller: docSearchController,
        matchedIds: searchMatchedIds,
        activeId: searchActiveId,
    } = useCanvasDocSearch({
        elements: doc.elements,
        frames: doc.frames,
        meta: doc.meta,
        onReveal: useCallback((el) => setSelectedIds([el.id]), [setSelectedIds]),
    });

    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: doc.yjsDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
        ready: doc.synced,
    });
    const {
        allComments,
        cards: lifecycleCards,
        createCard,
        assignComment,
        members,
        assignedCount,
        setOpenCardId,
    } = lifecycle;

    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    // A w-64 sibling occupies the right edge whenever the comment/activity pane or the properties
    // panel is up — inset the find bar clear of it (the slides rule).
    const rightPanelShown = (!isMobile && !!panel) || canEdit;

    const [addOpen, setAddOpen] = useState(false);
    // The element the pending "New comment" anchors to — set by the canvas menu's Comment row, null for
    // a card raised from the panel (which stays document-level).
    const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);

    const addCommentTo = useCallback((elementId: string) => {
        setCommentAnchorId(elementId);
        setAddOpen(true);
    }, []);

    const closeAdd = useCallback((open: boolean) => {
        setAddOpen(open);
        if (!open) setCommentAnchorId(null);
    }, []);

    // Opening a card reveals its anchor element; mobile hides the canvas, so there it just opens.
    const openCard = useCallback(
        (cardId: string) => {
            const el = elementForCommentCard(doc.elements, cardId);
            if (el) setSelectedIds([el.id]);
            setOpenCardId(cardId);
        },
        [doc.elements, setSelectedIds, setOpenCardId],
    );

    // Toolbar "Add image": the picker lives here, placement goes through the canvas' published
    // insert surface (placement needs the live viewport).
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const imageInsertRef = useRef<CanvasImageInsert | null>(null);

    // A comment raised from an element anchors to it; one raised from the panel stays document-level,
    // which is what every vector comment was before elements could carry them.
    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            const anchorId = commentAnchorId;
            const card = await createCard({ ...patch, attachments });
            if (card && anchorId) {
                const el = doc.elements.find((e) => e.id === anchorId);
                // Idempotent: a double submit must not list the same card twice on the element.
                const ids = el ? parseIdList(el.commentCardIds) : [];
                if (el && !ids.includes(card.id)) {
                    doc.updateElement(anchorId, { commentCardIds: serializeIdList([...ids, card.id]) });
                }
            }
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setCommentAnchorId(null);
            setAddOpen(false);
        },
        [commentAnchorId, createCard, assignComment, doc.elements, doc.updateElement],
    );

    // Delete drops the card from the `comments` Y.Map and strips it from its anchor element, so no
    // element keeps a flag for a card that is gone. The .eigenchat + comments.db row persist server-side.
    const deleteCard = useCallback(
        (cardId: string) => {
            const yjsDoc = doc.yjsDoc;
            if (!yjsDoc) return;
            const anchor = elementForCommentCard(doc.elements, cardId);
            yjsDoc.transact(() => {
                yjsDoc.getMap('comments').delete(cardId);
            });
            // Untracked: stripping the anchor is bookkeeping for a delete the UndoManager never saw (the
            // comments map is outside its scope), so ⌘Z must not resurrect the flag without its card.
            if (anchor) {
                const ids = parseIdList(anchor.commentCardIds).filter((id) => id !== cardId);
                doc.updateElementUntracked(anchor.id, { commentCardIds: serializeIdList(ids) });
            }
        },
        [doc.yjsDoc, doc.elements, doc.updateElementUntracked],
    );

    const panelProps = {
        onClose: closePanels,
        path,
        cards: lifecycleCards,
        entries: allComments,
        members,
        currentUserEmail: user?.email ?? '',
        filter: commentFilter,
        activeComments,
        commentContextMenu,
        // The mobile pane hides the canvas, so its element reveal would go unseen there.
        onOpenCard: isMobile ? setOpenCardId : openCard,
        onAddComment: canWrite && chatFolderId ? () => setAddOpen(true) : undefined,
    };

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <ColumnLayout>
                <UnsyncedEditsGuard active={doc.unsyncedEdits} />
                {/* The comment/activity pane hides the canvas on mobile (a Column sibling below); keep
                    the canvas mounted (hidden wrapper) so Yjs state + selection survive a pane visit. */}
                {/* Hiding takes the find bar with it: it floats in this wrapper, outside the Column. */}
                <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                    <DocSearchProvider
                        controller={docSearchController}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={onSearchOpenChange}
                        // right-68 = the w-64 right panel + the bar's own gutter.
                        barClassName={cn('top-14', rightPanelShown && 'right-68')}
                    >
                        <Column
                            id="editor"
                            width="flex"
                            className="flex-1 h-full"
                            toolbarBorder="always"
                            toolbar={
                                <Toolbar
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
                                    onInsertImage={
                                        canEdit && mediaFolderId ? () => setImagePickerOpen(true) : undefined
                                    }
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    onToggleCommentPanel={toggleComments}
                                    commentPanelOpen={commentPanelOpen}
                                    assignedCommentCount={assignedCount}
                                    onToggleActivityPanel={toggleActivity}
                                    activityPanelOpen={activityPanelOpen}
                                />
                            }
                        >
                            {/* Latched: a WS blip keeps the canvas mounted; `doc.synced` still gates presence. */}
                            {!doc.loaded ? (
                                <CollabLoadingState storageUnavailable={doc.storageUnavailable} />
                            ) : (
                                <div className="flex h-full w-full overflow-hidden">
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
                                            onOpenCard={openCard}
                                            onAddComment={canWrite && chatFolderId ? addCommentTo : undefined}
                                            searchMatchedIds={searchMatchedIds}
                                            searchActiveId={searchActiveId}
                                        />
                                    </div>
                                    {/* Right side: the comment/activity pane wins over the properties panel
                                    (the slides arrangement); mobile hosts the pane as an outside sibling.
                                    The panel stays up for the whole editing session — with nothing
                                    selected it edits the canvas itself. */}
                                    {!isMobile && panel ? (
                                        <PanelColumn activePanel={panel} {...panelProps} />
                                    ) : canEdit ? (
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
                                    ) : null}
                                </div>
                            )}

                            {mediaFolderId && (
                                <DrivePickerWithUpload
                                    open={imagePickerOpen}
                                    onOpenChange={setImagePickerOpen}
                                    title="Add image"
                                    mimeFilter={['image/*']}
                                    multiSelect
                                    onPickFromDrive={(paths) =>
                                        void imageInsertRef.current?.insertDrivePaths(paths).catch(() => {})
                                    }
                                    onPickFromDevice={(files) => imageInsertRef.current?.insertFiles(files)}
                                    accept="image/*"
                                    multiple
                                />
                            )}
                        </Column>
                    </DocSearchProvider>
                </div>

                {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}

                <CardFormDialog
                    open={addOpen}
                    onOpenChange={closeAdd}
                    onSave={handleSaveNew}
                    allowAttachments={!!mediaFolderId}
                    members={members}
                    currentUserEmail={user?.email}
                    dialogTitle="New comment"
                    submitLabel="Add comment"
                />

                <CommentLifecycleDialogs
                    lifecycle={lifecycle}
                    path={path}
                    canWrite={canWrite}
                    commentContextMenu={commentContextMenu}
                    onDelete={deleteCard}
                />
            </ColumnLayout>
        </MediaResolverProvider>
    );
}
