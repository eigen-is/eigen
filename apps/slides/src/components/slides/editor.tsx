import { useAuth } from '@workspace/lib/auth';
import { MediaResolverProvider, useCopyToMediaFolder, useMediaResolver, useUploadFile } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    parseBackgroundFill,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    type VectorElement,
} from '@workspace/lib/vector';
import { EmptyState, TooltipButton, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import {
    CanvasDocumentShell,
    CanvasEditor,
    type CanvasImageInsert,
    CanvasPropertiesPanel,
    CanvasToolbar,
    useActiveFrame,
    useCanvasCommentHost,
    useCanvasDoc,
    useCanvasDocSearch,
    useCanvasPresence,
    useSelection,
    useTool,
} from '@workspace/ui/components/vector';
import { Play, Plus, Presentation } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSlideDnd } from './hooks/use-slide-dnd';
import { PresentMode, presentStep } from './present-mode';
import { seedDeck } from './seed-deck';
import { SlideBackgroundPanel } from './slide-background-panel';
import { SlidePanel } from './slide-panel';

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
    const { dragActiveId, handleDragStart, handleDragEnd } = useSlideDnd({
        frames: doc.frames,
        moveFrame: doc.moveFrame,
    });
    const { tool, setTool, toolLocked, setToolLocked } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    const { user } = useAuth();
    // Presence carries the frame, so a peer's cursor shows only on the slide they are on.
    const publishCursor = useCanvasPresence(doc.provider, user, selectedIds, frameId);
    const { resolveMediaUrl } = useMediaResolver();
    const uploadFile = useUploadFile(ownerId, path.mountId);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, path.mountId);

    const { addFrame, deleteFrame, duplicateFrame, updateFrame, updateFrames } = doc;

    // The first writer to open an empty deck seeds its one slide (seed-deck.ts owns the why).
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

    // Revealing an element means going to its slide FIRST — ⌘F and the comment pane both span the
    // whole deck, so either can land on an element the canvas is not currently showing.
    const revealElement = useCallback(
        (el: VectorElement) => {
            setFrameId(el.frameId);
            setSelectedIds([el.id]);
        },
        [setFrameId, setSelectedIds],
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

    // A rail thumbnail rings when the slide holds a match: ⌘F spans the whole deck, so most hits are
    // on slides the canvas is not showing.
    const matchedFrameIds = useMemo(() => {
        const ids = new Set<string>();
        for (const el of doc.elements) if (searchMatchedIds.has(el.id)) ids.add(el.frameId);
        return ids;
    }, [doc.elements, searchMatchedIds]);

    const [isPresenting, setIsPresenting] = useState(false);

    // Adding a slide activates it, the way inserting one always has. Duplicate and delete are the
    // rail's own rows and arrive with it.
    const addSlide = useCallback(() => {
        const id = addFrame(frameId);
        if (id) setFrameId(id);
    }, [addFrame, frameId, setFrameId]);

    const duplicateSlide = useCallback(
        (id: string) => {
            const copyId = duplicateFrame(id);
            if (copyId) setFrameId(copyId);
        },
        [duplicateFrame, setFrameId],
    );

    // No fallback to pick here: useActiveFrame hands over to whatever now holds the deleted slide's
    // position. The rail disables the row for a one-slide deck, and this guards the keyboard path.
    const deleteSlide = useCallback(
        (id: string) => {
            if (doc.frames.length <= 1) return;
            deleteFrame(id);
        },
        [deleteFrame, doc.frames.length],
    );

    const enterPresent = useCallback(() => {
        // Nothing to show on a frameless deck, and latching isPresenting there would take fullscreen
        // for an empty screen with no canvas keymap left to leave it.
        if (doc.frames.length === 0) return;
        setSelectedIds([]);
        // Present unmounts the find-bar subtree without closing the session, so its rings would outlive
        // the exit — drop them on the way in.
        docSearchController.highlightAll([]);
        setIsPresenting(true);
        // No API (iOS Safari) or a rejected request still presents: the overlay is fixed inset-0.
        document.documentElement.requestFullscreen?.().catch(() => {});
    }, [doc.frames.length, setSelectedIds, docSearchController]);

    const exitPresent = useCallback(() => {
        setIsPresenting(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }, []);

    // Fullscreen also ends outside our control (the browser's own Esc, an Android back gesture) —
    // leave present with it.
    useEffect(() => {
        const onFullscreenChange = () => {
            if (!document.fullscreenElement) setIsPresenting(false);
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, []);

    const presentTo = useCallback(
        (delta: number) => {
            const next = presentStep(frameIndex, doc.frames.length, delta);
            if (next === -1) exitPresent();
            else setFrameId(doc.frames[next].id);
        },
        [frameIndex, doc.frames, exitPresent, setFrameId],
    );

    // Layered Escape, capture phase (docs/CANVAS.md § Layered Escape): present is the OUTERMOST layer
    // and claims Escape before anything else sees it; the find bar's own bubble-phase handler and the
    // canvas' text-edit / gesture / deselect layers keep the rest. A capture listener is required
    // because the bar closes itself on bubble, so a bubble handler here could never tell it had been
    // open. State rides a ref so the listener never goes stale.
    const presentingRef = useRef(false);
    presentingRef.current = isPresenting;
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !presentingRef.current) return;
            e.stopPropagation();
            exitPresent();
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [exitPresent]);

    // Toolbar "Add image": the picker lives here, placement goes through the canvas' published insert
    // surface (placement needs the live viewport).
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const imageInsertRef = useRef<CanvasImageInsert | null>(null);

    const background = frame ? parseBackgroundFill(frame.background) : null;
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

    // Present mode replaces the editor outright: no tools, no rail, no panels. The doc hook stays
    // mounted above it, so leaving present returns to the same slide with the same selection state —
    // and so does the leave guard, which must outlive the swap or a presenter's unsynced edits would
    // navigate away unwarned.
    if (isPresenting && frame) {
        return (
            <>
                <UnsyncedEditsGuard active={doc.unsyncedEdits} />
                <PresentMode
                    frame={frame}
                    elements={doc.elements}
                    onNext={() => presentTo(1)}
                    onPrev={() => presentTo(-1)}
                    onExit={exitPresent}
                />
            </>
        );
    }

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
                    exportFormats={['pdf', 'html']}
                    createLabel="New slides"
                    createIcon={Presentation}
                    createType="slides"
                    insertItems={
                        <DropdownMenuItem onClick={addSlide}>
                            <Plus className="h-4 w-4 mr-2" /> Slide
                        </DropdownMenuItem>
                    }
                    toolItems={<TooltipButton icon={Plus} tooltipText="Add slide" onClick={addSlide} />}
                    centerItems={<TooltipButton icon={Play} tooltipText="Present" onClick={enterPresent} />}
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
            }
        >
            {/* The rail is desktop-only: a phone pages with a swipe (spec D8), and a 52-wide column
                would take a third of the screen. */}
            {!isMobile && (
                <SlidePanel
                    frames={doc.frames}
                    elements={doc.elements}
                    activeFrameId={frameId}
                    onSelectFrame={setFrameId}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    dragActiveId={dragActiveId}
                    onDeleteSlide={canEdit ? deleteSlide : undefined}
                    onDuplicateSlide={canEdit ? duplicateSlide : undefined}
                    matchedFrameIds={matchedFrameIds}
                />
            )}
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
                            onOpenCard={comments.openCard}
                            onAddComment={canWrite && chatFolderId ? comments.addCommentTo : undefined}
                            searchMatchedIds={searchMatchedIds}
                            searchActiveId={searchActiveId}
                            // A view-only deck pages on a one-finger swipe; an editable one keeps
                            // that finger for the canvas (D4.13).
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
                    <EmptyState icon={<Presentation className="h-8 w-8" />} message="No slides yet" />
                </div>
            )}
        </CanvasDocumentShell>
    );
}
