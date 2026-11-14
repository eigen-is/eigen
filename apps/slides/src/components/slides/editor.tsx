// The slides editor: a deck drawn by the shared canvas engine in frame mode, one slide at a time.
// The slide route mounts it for an open deck. It adds what the engine has no word for, such as the
// slide rail, the phone's slide strip, present mode, page setup and the slide background panel.

import { useAuth } from '@workspace/lib/auth';
import { useCopyToMediaFolder, useMediaResolver, useUploadFile } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { VectorElement } from '@workspace/lib/vector';
import {
    elementsInFrame,
    parseBackgroundFill,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
} from '@workspace/lib/vector';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { ContextMenuAnchor, MenuSections, useContextMenu } from '@workspace/ui/components/context-menu';
import { DocumentImportPicker } from '@workspace/ui/components/drive';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { EmptyState, UnsyncedEditsGuard, useLayout } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { useAspectLock } from '@workspace/ui/components/properties-panel';
import type { CanvasHandle } from '@workspace/ui/components/vector';
import {
    CanvasDocumentShell,
    CanvasEditor,
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
import { ArrowDownToLine, ArrowUpToLine, CopyPlus, FileSliders, Play, Plus, Presentation, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSlideDnd } from './hooks/use-slide-dnd';
import { PageSetupDialog } from './page-setup-dialog';
import { PresentMode, presentStep } from './present-mode';
import { seedDeck } from './seed-deck';
import { SlideBackgroundPanel } from './slide-background-panel';
import { SlidePanel, SlideStrip } from './slide-panel';

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

// Tool, selection and the active frame live here, so the toolbar, rail, canvas and panel share them.
// The viewport, gestures, keymap, clipboard and in-place editing all belong to the engine.
export function SlideEditor({
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
    // Phones view the deck but never edit it. The file menu, the share buttons and comments still follow
    // canWrite. Tablets count as desktop here.
    const canEdit = canWrite && !isMobile;
    const doc = useCanvasDoc(ownerId, path.mountId, path.id, SLIDES_STYLE_DEFAULTS);
    const { frameId, setFrameId, index: frameIndex, step: stepFrame } = useActiveFrame(doc.frames);
    const { dragActiveId, handleDragStart, handleDragEnd } = useSlideDnd({
        frames: doc.frames,
        moveFrame: doc.moveFrame,
    });
    const { tool, setTool, toolLocked, setToolLocked } = useTool();
    const { selectedIds, setSelectedIds, toggle } = useSelection();
    // The canvas reports an open text editor, so the toolbar's Edit rows stand down as the canvas's keys do.
    const [textEditing, setTextEditing] = useState(false);
    const { user } = useAuth();
    // Presence carries the frame, so a peer's cursor shows only on the slide they are on.
    const publishCursor = useCanvasPresence(doc.provider, user, selectedIds, frameId);
    const { resolveMediaUrl } = useMediaResolver();
    const { mutateAsync: uploadFile } = useUploadFile(ownerId, path.mountId);
    const { mutateAsync: copyToMediaFolder } = useCopyToMediaFolder(ownerId, path.mountId);

    const { addFrame, deleteFrame, duplicateFrame, updateFrame, updateFrames } = doc;

    // The first writer to open an empty deck seeds its one slide.
    useEffect(() => {
        const yjsDoc = doc.yjsDoc;
        if (!doc.loaded || !canWrite || !yjsDoc) return;
        seedDeck(yjsDoc);
    }, [doc.loaded, canWrite, doc.yjsDoc]);

    const frame = doc.frames.find((f) => f.id === frameId);
    // The slide's own elements: the z-order arithmetic behind the panel's Arrange row must see the
    // same list the canvas and the keymap do, because indices are allocated across the whole deck.
    const frameElements = useMemo(() => elementsInFrame(doc.elements, frameId), [doc.elements, frameId]);
    const selectedElements = useMemo(
        () => doc.elements.filter((el) => selectedIds.includes(el.id)),
        [doc.elements, selectedIds],
    );
    // The aspect lock lives here, so the panel's checkbox and the canvas' resize handles share one setting.
    const allImageSelected = selectedElements.length > 0 && selectedElements.every((el) => el.type === 'image');
    const [aspectLocked, setAspectLocked] = useAspectLock(selectedIds, allImageSelected);

    // Revealing an element goes to its slide first. ⌘F and the comment pane both span the whole deck,
    // so either can land on an element the canvas is not showing.
    const revealElement = useCallback(
        (el: VectorElement) => {
            // An element may sit on no live slide, such as when a peer deleted its slide. Going to its frame
            // would empty the canvas, so it is selected on the current slide instead.
            if (doc.frames.some((f) => f.id === el.frameId)) setFrameId(el.frameId);
            setSelectedIds([el.id]);
        },
        [doc.frames, setFrameId, setSelectedIds],
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

    // A search result names its slide, such as "Slide 3". The number follows the stored frame order.
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
    const [pageSetupOpen, setPageSetupOpen] = useState(false);

    // A new slide, added or duplicated, becomes the active one.
    const addSlideAfter = (afterId: string | null) => {
        const id = addFrame(afterId);
        if (id) setFrameId(id);
    };

    const addSlideAbove = (id: string) => {
        const index = doc.frames.findIndex((f) => f.id === id);
        addSlideAfter(index > 0 ? doc.frames[index - 1].id : null);
    };

    const duplicateSlide = (id: string) => {
        const copyId = duplicateFrame(id);
        if (copyId) setFrameId(copyId);
    };

    // The rail thumbnail's menu. A right-click on empty canvas opens the canvas' own menu, with these
    // rows below its Paste.
    const slideMenu = useContextMenu<string>();
    const menuFrameId = slideMenu.item;

    const slideMenuSections = (id: string): MenuSectionsProps => ({
        create: (
            <>
                <DropdownMenuItem onClick={() => addSlideAbove(id)}>
                    <ArrowUpToLine className="h-4 w-4" /> New slide above
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => addSlideAfter(id)}>
                    <ArrowDownToLine className="h-4 w-4" /> New slide below
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => duplicateSlide(id)}>
                    <CopyPlus className="h-4 w-4" /> Duplicate slide
                </DropdownMenuItem>
            </>
        ),
        destructive: (
            <DropdownMenuItem variant="destructive" disabled={doc.frames.length <= 1} onClick={() => deleteFrame(id)}>
                <Trash2 className="h-4 w-4" /> Delete slide
            </DropdownMenuItem>
        ),
    });

    const enterPresent = useCallback(() => {
        // Nothing to show on a frameless deck, and latching isPresenting there would take fullscreen
        // for an empty screen with no canvas keymap left to leave it.
        if (doc.frames.length === 0) return;
        setSelectedIds([]);
        // Present unmounts the find bar without closing its session, so its rings would outlive the
        // exit. They are dropped on the way in.
        docSearchController.highlightAll([]);
        setIsPresenting(true);
        // Present still works without fullscreen, such as on iOS Safari or after a refused request,
        // because its overlay covers the whole viewport on its own.
        document.documentElement.requestFullscreen?.().catch(() => {});
    }, [doc.frames.length, setSelectedIds, docSearchController]);

    const exitPresent = useCallback(() => {
        setIsPresenting(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }, []);

    // Fullscreen can also end outside our control, such as the browser's own Esc or an Android back
    // gesture. Present ends with it.
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

    // Present is Escape's outermost layer. It listens in the capture phase because the find bar closes
    // itself on bubble, so a bubble handler here could never tell the bar had been open.
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

    // The toolbar's Add image opens the picker here, and the canvas handle places what was picked.
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    const insertImage = canEdit && mediaFolderId ? () => setImagePickerOpen(true) : undefined;
    const canvasRef = useRef<CanvasHandle | null>(null);

    const background = frame ? parseBackgroundFill(frame.background) : null;
    const backgroundImageUrl = background?.type === 'image' ? resolveMediaUrl(background.mediaName) : null;

    // Both hooks toast their own failure. The catch only ends the rejection, so a failed upload or copy
    // sets no background.
    const uploadBackgroundImage = useCallback(
        async (file: File): Promise<string | null> => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return null;
            const result = await uploadFile({ parentId: mediaFolderId, file }).catch(() => null);
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

    // Present mode replaces the editor outright, and the doc hook stays mounted above it, so leaving
    // returns to the same slide. It renders the leave guard too, or unsynced edits could go unwarned.
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
                    createLabel="New slides"
                    createIcon={Presentation}
                    createType="slides"
                    onImport={() => setImportPickerOpen(true)}
                    fileItems={
                        <DropdownMenuItem onClick={() => setPageSetupOpen(true)}>
                            <FileSliders className="h-4 w-4" /> Page setup…
                        </DropdownMenuItem>
                    }
                    insertItems={
                        <>
                            <DropdownMenuItem onClick={() => addSlideAfter(frameId)}>
                                <Plus className="h-4 w-4" /> New slide
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                        </>
                    }
                    centerItems={
                        <TooltipButton
                            icon={Play}
                            tooltipText="Present"
                            onClick={enterPresent}
                            className="bg-[var(--app-current-color-soft)] text-[var(--app-current-color)] hover:bg-[var(--app-current-color-soft)] hover:text-[var(--app-current-color)]"
                        />
                    }
                    onToggleCommentPanel={comments.toggleComments}
                    commentPanelOpen={comments.commentPanelOpen}
                    assignedCommentCount={comments.assignedCount}
                    onToggleActivityPanel={comments.toggleActivity}
                    activityPanelOpen={comments.activityPanelOpen}
                />
            }
            propertiesPanel={
                <CanvasPropertiesPanel
                    elements={frameElements}
                    selectedElements={selectedElements}
                    updateElements={doc.updateElements}
                    reorderElements={doc.reorderElements}
                    replaceElement={doc.replaceElement}
                    setSelectedIds={setSelectedIds}
                    undoManager={doc.undoManager}
                    aspectLocked={aspectLocked}
                    onAspectLockChange={setAspectLocked}
                    slideWidth={doc.meta.slideWidth}
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
            {/* The rail is desktop-only, because its column would take half a phone's width. A phone gets
                the strip under the deck instead. */}
            {!isMobile && (
                <SlidePanel
                    frames={doc.frames}
                    elements={doc.elements}
                    activeFrameId={frameId}
                    onSelectFrame={setFrameId}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    dragActiveId={dragActiveId}
                    slideMenu={canEdit ? slideMenu : undefined}
                    matchedFrameIds={matchedFrameIds}
                />
            )}
            {frame ? (
                <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex-1 min-h-0">
                        <CanvasEditor
                            doc={doc}
                            styleDefaults={SLIDES_STYLE_DEFAULTS}
                            viewport="frame"
                            frameId={frameId}
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
                            backgroundMenu={slideMenuSections(frameId)}
                            // A view-only deck pages on a one-finger swipe. An editable one keeps
                            // that finger for the canvas.
                            onSwipeFrame={canEdit ? undefined : stepFrame}
                        />
                    </div>
                    {isMobile && (
                        <SlideStrip
                            frames={doc.frames}
                            elements={doc.elements}
                            activeFrameId={frameId}
                            onSelectFrame={setFrameId}
                            matchedFrameIds={matchedFrameIds}
                        />
                    )}
                    <div className="h-8 bg-muted border-t flex items-center justify-between app-gutter-x text-xs text-muted-foreground">
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
            <ContextMenuAnchor contextMenu={slideMenu}>
                {menuFrameId && <MenuSections {...slideMenuSections(menuFrameId)} />}
            </ContextMenuAnchor>
            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                target="eigenslides"
                afterFrameId={frameId}
            />
            {/* doc.meta re-reads on a peer's write, so the open dialog follows it. */}
            <PageSetupDialog
                open={pageSetupOpen}
                onOpenChange={setPageSetupOpen}
                slideSize={doc.meta.slideSize}
                canWrite={canEdit}
                onSlideSizeChange={(slideSize) => doc.updateMeta({ slideSize })}
            />
        </CanvasDocumentShell>
    );
}
