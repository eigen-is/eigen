import { useAuth } from '@workspace/lib/auth';
import { useCommentCards, useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import { MediaResolverProvider, useCopyToMediaFolder, useMediaResolver, useUploadFile } from '@workspace/lib/drive';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    elementForCommentCard,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    type VectorElement,
    withCommentCard,
    withoutCommentCard,
} from '@workspace/lib/vector';
import { CollabLoadingState, Column, ColumnLayout, EmptyState, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
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
    useActiveFrame,
    useCanvasComments,
    useCanvasDoc,
    useCanvasDocSearch,
    useCanvasPresence,
    useSelection,
    useTool,
} from '@workspace/ui/components/vector';
import { cn } from '@workspace/ui/lib/utils';
import { Presentation } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { seedDeck } from './seed-deck';
import { frameBackground, SlideBackgroundPanel } from './slide-background-panel';
import { Toolbar } from './toolbar';

type SlideEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
};

// The media provider wraps the deck rather than living inside it: the editor itself calls
// useMediaResolver (for the slide background's preview URL), and a hook cannot read a context its own
// component provides. `key` remounts the whole editor when the route swaps documents.
export function SlideEditor(props: SlideEditorProps) {
    const { ownerId, path, mediaFolderId, chatFolderId } = props;
    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <SlideEditorInner key={path.id} {...props} />
        </MediaResolverProvider>
    );
}

// The deck: a canvas of 1920x1080 frames, one per slide. Tool, selection and the active frame are
// lifted here so the toolbar, rail, canvas and panel share one source; the viewport, gestures,
// keymap, clipboard and in-place editing are all the engine's.
function SlideEditorInner({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: SlideEditorProps) {
    const { isMobile } = useLayout();
    // Phones view the deck, never edit it (the shared canEdit split: the file menu, share cluster and
    // comments keep canWrite); tablets sit above the breakpoint.
    const canEdit = canWrite && !isMobile;
    const doc = useCanvasDoc(ownerId, path.mountId, path.id, SLIDES_STYLE_DEFAULTS);
    const { frameId, setFrameId, index: frameIndex, step: stepFrame } = useActiveFrame(doc.frames);
    const { tool, setTool, toolLocked, setToolLocked } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    const { user } = useAuth();
    // Presence carries the frame, so a peer's cursor shows only on the slide they are on.
    const publishCursor = useCanvasPresence(doc.provider, user, selectedIds, frameId);
    const { resolveMediaUrl } = useMediaResolver();
    const uploadFile = useUploadFile(ownerId, path.mountId);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, path.mountId);

    const { addFrame, updateFrame, updateFrames } = doc;

    // A deck always has at least one slide, and nothing server-side writes a new container's Yjs
    // content — so the first WRITER to open an empty deck seeds it. The emptiness test reads the LIVE
    // Y.Doc, not React state (which is one render behind a sync and would let a second effect run seed
    // twice), and seedDeck itself re-checks inside its transact.
    useEffect(() => {
        const yjsDoc = doc.yjsDoc;
        if (!doc.loaded || !canWrite || !yjsDoc) return;
        seedDeck(yjsDoc);
    }, [doc.loaded, canWrite, doc.yjsDoc]);

    const frame = doc.frames.find((f) => f.id === frameId);
    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    // Aspect lock, lifted so the panel checkbox and the canvas' ObjectTransform share one setting.
    const allImageSelected = selectedElements.length > 0 && selectedElements.every((el) => el.type === 'image');
    const [aspectLocked, setAspectLocked] = useAspectLock(selectedIds.join(','), allImageSelected);

    // Comments + activity (the shared PanelColumn shape). Every card stays active; one anchored to an
    // element takes that element's own text as its panel row.
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

    // Revealing an element means going to its slide FIRST — ⌘F and the comment pane both span the
    // whole deck, so either can land on an element the canvas is not currently showing.
    const revealElement = useCallback(
        (el: VectorElement) => {
            setFrameId(el.frameId);
            setSelectedIds([el.id]);
        },
        [setFrameId, setSelectedIds],
    );

    // "Slide 3" — where a match is, in the deck's words. Frame order is the stored order.
    const frameNumbers = useMemo(() => new Map(doc.frames.map((f, i) => [f.id, i + 1])), [doc.frames]);
    const contextOf = useCallback(
        (el: VectorElement) => {
            const number = frameNumbers.get(el.frameId);
            return number === undefined ? undefined : `Slide ${number}`;
        },
        [frameNumbers],
    );

    const {
        controller: docSearchController,
        matchedIds: searchMatchedIds,
        activeId: searchActiveId,
    } = useCanvasDocSearch({
        elements: doc.elements,
        frames: doc.frames,
        meta: doc.meta,
        onReveal: revealElement,
        contextOf,
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

    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const [addOpen, setAddOpen] = useState(false);
    // The element a pending "New comment" anchors to — null for a card raised from the pane, which
    // stays document-level.
    const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);
    const addCommentTo = useCallback((elementId: string) => {
        setCommentAnchorId(elementId);
        setAddOpen(true);
    }, []);
    const closeAdd = useCallback((open: boolean) => {
        setAddOpen(open);
        if (!open) setCommentAnchorId(null);
    }, []);

    // Opening a card reveals its anchor; the mobile pane hides the canvas, so there it just opens.
    const openCard = useCallback(
        (cardId: string) => {
            const el = elementForCommentCard(doc.elements, cardId);
            if (el) revealElement(el);
            setOpenCardId(cardId);
        },
        [doc.elements, revealElement, setOpenCardId],
    );

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
                if (el) doc.updateElement(anchorId, { commentCardIds: withCommentCard(el, card.id) });
            }
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setCommentAnchorId(null);
            setAddOpen(false);
        },
        [commentAnchorId, createCard, assignComment, doc.elements, doc.updateElement],
    );

    // Delete drops the card from the `comments` Y.Map and strips it from its anchor, so no element
    // keeps a flag for a card that is gone.
    const deleteCard = useCallback(
        (cardId: string) => {
            const yjsDoc = doc.yjsDoc;
            if (!yjsDoc) return;
            const anchor = elementForCommentCard(doc.elements, cardId);
            yjsDoc.transact(() => {
                yjsDoc.getMap('comments').delete(cardId);
            });
            if (anchor) doc.updateElement(anchor.id, { commentCardIds: withoutCommentCard(anchor, cardId) });
        },
        [doc.yjsDoc, doc.elements, doc.updateElement],
    );

    // Adding a slide activates it, the way inserting one always has. Duplicate and delete are the
    // rail's own rows and arrive with it.
    const addSlide = useCallback(() => {
        const id = addFrame(frameId);
        if (id) setFrameId(id);
    }, [addFrame, frameId, setFrameId]);

    // Toolbar "Add image": the picker lives here, placement goes through the canvas' published insert
    // surface (placement needs the live viewport).
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const imageInsertRef = useRef<CanvasImageInsert | null>(null);

    const background = frameBackground(frame);
    const backgroundImageUrl = background?.type === 'image' ? resolveMediaUrl(background.mediaName) : null;

    const uploadBackgroundImage = useCallback(
        async (file: File): Promise<string | null> => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return null;
            const result = await uploadFile.mutateAsync({ parentId: mediaFolderId, file }).catch(() => null);
            return result?.name ?? null;
        },
        [mediaFolderId, uploadFile],
    );

    const pickBackgroundImage = useCallback(
        async (paths: DrivePath[]) => {
            if (!mediaFolderId || paths.length === 0 || !frame) return;
            const copied = await copyToMediaFolder({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            const name = copied?.[0]?.name;
            if (name) {
                updateFrame(frame.id, {
                    background: serializeBackgroundFill({ type: 'image', mediaName: name, fit: 'cover' }),
                });
            }
        },
        [mediaFolderId, frame, copyToMediaFolder, updateFrame],
    );

    // A w-64 sibling occupies the right edge whenever the comment/activity pane or the properties
    // panel is up — inset the find bar clear of it.
    const rightPanelShown = (!isMobile && !!panel) || canEdit;

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
        <ColumnLayout>
            <UnsyncedEditsGuard active={doc.unsyncedEdits} />
            {/* The pane hides the deck on mobile (a Column sibling below); keep it mounted (hidden
                wrapper) so Yjs state, selection and the active slide survive a pane visit. */}
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
                                onAddSlide={addSlide}
                                onPresent={() => {}}
                                onInsertImage={canEdit && mediaFolderId ? () => setImagePickerOpen(true) : undefined}
                                onAccessDialogOpen={onAccessDialogOpen}
                                onToggleCommentPanel={toggleComments}
                                commentPanelOpen={commentPanelOpen}
                                assignedCommentCount={assignedCount}
                                onToggleActivityPanel={toggleActivity}
                                activityPanelOpen={activityPanelOpen}
                            />
                        }
                    >
                        {/* Latched: a WS blip keeps the deck mounted; `doc.synced` still gates presence. */}
                        {!doc.loaded ? (
                            <CollabLoadingState storageUnavailable={doc.storageUnavailable} />
                        ) : (
                            <div className="flex h-full w-full overflow-hidden">
                                {frame ? (
                                    <div className="flex-1 min-w-0 flex flex-col">
                                        <div className="flex-1 min-h-0">
                                            <CanvasEditor
                                                doc={doc}
                                                viewport="frame"
                                                frameId={frameId}
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
                                                // A view-only deck pages on a one-finger swipe; an editable
                                                // one keeps that finger for the canvas (D4.13).
                                                onSwipeFrame={canEdit ? undefined : stepFrame}
                                            />
                                        </div>
                                        <div className="h-8 bg-muted border-t flex items-center justify-between px-4 text-xs text-muted-foreground">
                                            <span>
                                                Slide {frameIndex + 1} of {doc.frames.length}
                                            </span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex-1 min-w-0">
                                        <EmptyState
                                            icon={<Presentation className="h-8 w-8" />}
                                            message="No slides yet"
                                        />
                                    </div>
                                )}
                                {/* Right side: the comment/activity pane wins over the properties panel;
                                    mobile hosts the pane as an outside sibling. */}
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
                                        viewport="frame"
                                        aspectLocked={aspectLocked}
                                        onAspectLockChange={setAspectLocked}
                                        emptyTitle="Slide"
                                        emptySection={
                                            frame ? (
                                                <SlideBackgroundPanel
                                                    frames={doc.frames}
                                                    frameId={frame.id}
                                                    background={background}
                                                    backgroundImageUrl={backgroundImageUrl}
                                                    updateFrames={updateFrames}
                                                    onUploadImage={uploadBackgroundImage}
                                                    onPickImageFromDrive={(paths) => {
                                                        void pickBackgroundImage(paths);
                                                    }}
                                                />
                                            ) : null
                                        }
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
    );
}
