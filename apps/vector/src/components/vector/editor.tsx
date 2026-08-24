import { useAuth } from '@workspace/lib/auth';
import { useCommentCards, useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { MediaResolverProvider } from '@workspace/lib/drive';
import type { ActiveComments, CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, LoadingState, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import { type CommentContextMenuItem, CommentLifecycleDialogs, PanelColumn } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import {
    useSelection,
    useTool,
    useVectorDoc,
    useVectorPresence,
    VectorCanvas,
    VectorPropertiesPanel,
} from '@workspace/ui/components/vector';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useMemo, useState } from 'react';
import { Toolbar } from './toolbar';

type VectorEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
};

// A document-level comment attaches to the whole vector document, not to any element (no
// element anchoring — that would reintroduce the Y.Array field ELEMENT_FIELDS eliminated, spec §1
// D14). So every card in the `comments` Y.Map is "active"; there are no orphans and no per-element
// anchor text.
const EMPTY_ANCHOR_TEXTS: Map<string, string> = new Map();

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
}: VectorEditorProps) {
    const doc = useVectorDoc(ownerId, path.mountId, path.id);
    const { tool, setTool } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    // Awareness: publish this user's identity + selection, get a throttled cursor publisher for the
    // canvas. Selection is threaded from here (the editor owns selectedIds).
    const { user } = useAuth();
    const publishCursor = useVectorPresence(doc.provider, user, selectedIds);
    const { isMobile } = useLayout();

    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    const showPanel = canWrite && selectedElements.length > 0;

    // Aspect lock (Override 3), lifted here so the panel checkbox and the canvas' ObjectTransform
    // resizeMode share one ephemeral setting. Default ON for image-only selections (D8b).
    const allImageSelected = selectedElements.length > 0 && selectedElements.every((el) => el.type === 'image');
    const [aspectLocked, setAspectLocked] = useAspectLock(selectedIds.join(','), allImageSelected);

    // Document-level comments + activity (the slides PanelColumn shape). Every card in the `comments`
    // Y.Map is active — read them here so the "active" set is derived independently of the lifecycle's
    // own card read (the slides idiom, where useActiveComments is the independent anchor source).
    const cards = useCommentCards(doc.yjsDoc, 'comments');
    const activeComments = useMemo<ActiveComments>(
        () => ({ ids: new Set(Object.keys(cards)), anchorTexts: EMPTY_ANCHOR_TEXTS }),
        [cards],
    );

    const { panel, commentPanelOpen, activityPanelOpen, mobilePanelOpen, toggleComments, toggleActivity, closePanels } =
        useDocumentPanels(isMobile);

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
        unresolvedCount,
        setOpenCardId,
    } = lifecycle;

    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const [addOpen, setAddOpen] = useState(false);

    // Document-level create: the card anchors to the document (no anchor callback), so it lands in the
    // `comments` Y.Map and is active by construction.
    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            const card = await createCard({ ...patch, attachments });
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setAddOpen(false);
        },
        [createCard, assignComment],
    );

    // Document-level delete: there is no host anchor to strip, so Delete removes the card from the
    // `comments` Y.Map directly. The .eigenchat + comments.db row persist server-side.
    const deleteCard = useCallback(
        (cardId: string) => {
            const yjsDoc = doc.yjsDoc;
            if (!yjsDoc) return;
            yjsDoc.transact(() => {
                yjsDoc.getMap('comments').delete(cardId);
            });
        },
        [doc.yjsDoc],
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
        onOpenCard: setOpenCardId,
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
                {/* The comment/activity pane hides the canvas on mobile (a Column sibling below); keep
                    the canvas mounted (hidden wrapper) so Yjs state + selection survive a pane visit. */}
                <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                    <Column
                        id="editor"
                        width="w-full"
                        className="flex-1 h-full"
                        toolbarBorder="always"
                        toolbar={
                            <Toolbar
                                path={path}
                                canWrite={canWrite}
                                undoManager={doc.undoManager}
                                tool={tool}
                                setTool={setTool}
                                onAccessDialogOpen={onAccessDialogOpen}
                                onToggleCommentPanel={toggleComments}
                                commentPanelOpen={commentPanelOpen}
                                unresolvedCommentCount={unresolvedCount}
                                onToggleActivityPanel={toggleActivity}
                                activityPanelOpen={activityPanelOpen}
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
                                        aspectLocked={aspectLocked}
                                        provider={doc.provider}
                                        publishCursor={publishCursor}
                                    />
                                </div>
                                {/* Right side: the comment/activity pane wins over the properties panel
                                    (the slides arrangement); mobile hosts the pane as an outside sibling. */}
                                {!isMobile && panel ? (
                                    <PanelColumn activePanel={panel} {...panelProps} />
                                ) : showPanel ? (
                                    <VectorPropertiesPanel
                                        elements={doc.elements}
                                        selectedElements={selectedElements}
                                        updateElements={doc.updateElements}
                                        undoManager={doc.undoManager}
                                        aspectLocked={aspectLocked}
                                        onAspectLockChange={setAspectLocked}
                                    />
                                ) : null}
                            </div>
                        )}
                    </Column>
                </div>

                {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}

                <CardFormDialog
                    open={addOpen}
                    onOpenChange={setAddOpen}
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
