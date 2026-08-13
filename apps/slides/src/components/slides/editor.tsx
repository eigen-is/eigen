import { useHotkey } from '@tanstack/react-hotkeys';
import { useAuth } from '@workspace/lib/auth';
import { getBackgroundStyle } from '@workspace/lib/background';
import {
    needsReUpload,
    readEigenClipboard,
    reUploadImage,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import { useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
} from '@workspace/lib/drive';
import { escapeHtml } from '@workspace/lib/html';
import { htmlToPlainText } from '@workspace/lib/html-dom';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    CardFormDialog,
    Column,
    ColumnLayout,
    CommentLifecycleDialogs,
    EmptyState,
    LoadingState,
    PanelColumn,
    useLayout,
} from '@workspace/ui';
import type { CommentContextMenuItem } from '@workspace/ui/components/layout/comments';
import { useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/layout/drive/drive-picker-with-upload';
import { DocSearchProvider } from '@workspace/ui/components/layout/search/doc-search-provider';
import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ArrangeOp, computeArrange } from './arrange';
import { useActiveComments } from './hooks/use-active-comments';
import { useDeck } from './hooks/use-deck';
import { useSlideDnd } from './hooks/use-slide-dnd';
import { useSlidesDocSearch } from './hooks/use-slides-doc-search';
import { SlideCanvas } from './slide-canvas';
import { ReadOnlySlideObject } from './slide-object';
import { SlidePanel } from './slide-panel';
import { SlideBackgroundPanel, SlidePropertiesPanel } from './slide-properties-panel';
import { Toolbar } from './toolbar';
import { DEFAULT_IMAGE_OBJECT, DEFAULT_TEXT_OBJECT, type ImageObject, type SlideObject } from './types';

function buildClipboardItem(
    obj: SlideObject,
    resolveMediaPath: (name: string) => DrivePath | undefined,
): EigenClipboardItem | null {
    const rect = { x: obj.x, y: obj.y, w: obj.w, h: obj.h, rotation: obj.rotation };
    const border = { borderColor: obj.borderColor, borderWidth: obj.borderWidth, borderRadius: obj.borderRadius };
    if (obj.type === 'image') {
        const mediaPath = resolveMediaPath(obj.mediaName);
        if (!mediaPath) return null;
        return {
            type: 'image',
            mediaName: obj.mediaName,
            sourcePathId: mediaPath.id,
            sourceParentId: mediaPath.parentId,
            sourceOwnerId: mediaPath.ownerId,
            sourceMountId: mediaPath.mountId,
            meta: { ...rect, ...border, objectFit: obj.objectFit },
        };
    }
    return {
        type: 'text',
        text: obj.text,
        meta: {
            ...rect,
            ...border,
            fontFamily: obj.fontFamily,
            fontSize: obj.fontSize,
            fontWeight: obj.fontWeight,
            fontStyle: obj.fontStyle,
            textDecoration: obj.textDecoration,
            textAlign: obj.textAlign,
            verticalAlign: obj.verticalAlign,
            color: obj.color,
            letterSpacing: obj.letterSpacing,
            lineHeight: obj.lineHeight,
            highlightColor: obj.highlightColor,
            background: obj.background,
        },
    };
}

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
    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <SlideEditorInner
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={onAccessDialogOpen}
                initialChatName={initialChatName}
                initialSearchTerm={initialSearchTerm}
            />
        </MediaResolverProvider>
    );
}

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
    const {
        deck,
        isSynced,
        activeSlideId,
        setActiveSlideId,
        addSlide,
        deleteSlide,
        duplicateSlide,
        updateSlideBackground,
        addObject,
        duplicateObjects,
        updateObject,
        updateObjects,
        deleteObject,
        deleteObjects,
        yjsDoc,
        undoManager,
        moveObjectUp,
        moveObjectDown,
        moveObjectToFront,
        moveObjectToBack,
        addCommentToObject,
        removeCommentFromObject,
    } = useDeck(ownerId, path.mountId, path.id);

    const { isMobile } = useLayout();
    const { resolveMediaUrl, resolveMediaPath, startUpload } = useMediaResolver();
    const { dragState, handleDragStart, handleDragEnd } = useSlideDnd({ yjsDoc });

    const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
    const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
    const [isPresenting, setIsPresenting] = useState(false);
    const [imagePickerOpen, setImagePickerOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const {
        controller: docSearchController,
        highlightedSlideIds,
        matchedObjectIds,
        searchActiveObjectId,
        clearHighlights,
    } = useSlidesDocSearch({ deck, setActiveSlideId });

    // Entering present unmounts the DocSearchProvider subtree without closing the bar, so its rings
    // would survive an exit-with-bar-closed. Drop them on enter.
    useEffect(() => {
        if (isPresenting) clearHighlights();
    }, [isPresenting, clearHighlights]);

    // Present chrome: the exit X shows on entry and on any pointer activity, then fades away again.
    const [presentControlsVisible, setPresentControlsVisible] = useState(false);
    const presentControlsTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const revealPresentControls = useCallback(() => {
        setPresentControlsVisible(true);
        clearTimeout(presentControlsTimerRef.current);
        presentControlsTimerRef.current = setTimeout(() => setPresentControlsVisible(false), 2000);
    }, []);
    useEffect(() => {
        if (isPresenting) revealPresentControls();
        return () => clearTimeout(presentControlsTimerRef.current);
    }, [isPresenting, revealPresentControls]);

    const exitPresent = useCallback(() => {
        setIsPresenting(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }, []);

    // Fullscreen also ends outside our control (Esc, Android back gesture) — leave present with it.
    useEffect(() => {
        const onFullscreenChange = () => {
            if (!document.fullscreenElement) setIsPresenting(false);
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, []);

    const auth = useAuth();
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
    // The layered Escape below still needs the plain open flag.
    const handleSearchOpenChange = useCallback(
        (open: boolean) => {
            setSearchOpen(open);
            onSearchOpenChange(open);
        },
        [onSearchOpenChange],
    );
    const [addOpen, setAddOpen] = useState(false);
    const [addInitialTitle, setAddInitialTitle] = useState('');
    const [addTargetObjId, setAddTargetObjId] = useState<string | null>(null);

    const activeComments = useActiveComments(deck);
    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yjsDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
        ready: isSynced,
    });
    const {
        allComments,
        resolveComment,
        cards,
        createCard,
        updateCard,
        assignComment,
        members,
        unresolvedCount,
        setOpenCardId,
    } = lifecycle;

    // Opening a comment card also reveals its slide + selects the anchored object (panel + activity share this).
    const openCommentCard = (cardId: string) => {
        for (const obj of Object.values(deck.objects)) {
            if (obj.commentCardIds?.includes(cardId)) {
                setActiveSlideId(obj.slideId);
                setSelectedObjectIds([obj.id]);
                setEditingObjectId(null);
                break;
            }
        }
        setOpenCardId(cardId);
    };

    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const panelProps = {
        onClose: closePanels,
        path,
        cards,
        entries: allComments,
        members,
        currentUserEmail: auth.user!.email,
        filter: commentFilter,
        activeComments,
        commentContextMenu,
        // The mobile pane hides the canvas, so its slide + object reveal would go unseen there.
        onOpenCard: isMobile ? setOpenCardId : openCommentCard,
    };

    const uploadFile = useUploadFile(ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(ownerId, path.mountId);

    const hasSelection = selectedObjectIds.length > 0;
    const isEditing = editingObjectId !== null;

    // Present is a read-only view of a live deck, or a stray key mutates the slide the audience sees.
    const canEdit = canWrite && !isPresenting;

    useYjsUndoHotkeys(undoManager, canEdit);
    useHotkey(
        'Delete',
        () => {
            deleteObjects(selectedObjectIds);
            setSelectedObjectIds([]);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    useHotkey(
        'Backspace',
        () => {
            deleteObjects(selectedObjectIds);
            setSelectedObjectIds([]);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    // Layered Escape (amendment 12): present → text-edit → bar → deselect. This is a capture-phase
    // document listener (NOT useHotkey): the find bar's own Escape runs in the bubble phase and closes
    // the bar before any bubble handler here could tell it had been open, and useHotkey's callback sync
    // goes stale once a second document Escape (the bar's) is registered. Capturing lets us read the
    // live state first: when the bar is open we do nothing and let Escape bubble to the bar (close
    // without deselecting); present/text-edit claim Escape and stop it; otherwise deselect (no
    // stopPropagation, so dialogs and other layers still receive Escape). State is read from a ref so
    // this listener never goes stale.
    const escStateRef = useRef({ isPresenting, isEditing, searchOpen });
    escStateRef.current = { isPresenting, isEditing, searchOpen };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const { isPresenting: presenting, isEditing: editing, searchOpen: barOpen } = escStateRef.current;
            if (presenting) {
                e.stopPropagation();
                exitPresent();
            } else if (editing) {
                e.stopPropagation();
                setEditingObjectId(null);
            } else if (!barOpen) {
                // bar open ⇒ let Escape bubble to the find bar so it closes without deselecting
                setSelectedObjectIds([]);
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [exitPresent]);
    const moveSelected = useCallback(
        (dx: number, dy: number) => {
            if (!yjsDoc) return;
            yjsDoc.transact(() => {
                const objectsMap = yjsDoc.getMap('objects');
                for (const id of selectedObjectIds) {
                    const obj = deck.objects[id];
                    if (!obj) continue;
                    const objMap = objectsMap.get(id) as import('yjs').Map<unknown> | undefined;
                    if (!objMap) continue;
                    objMap.set('x', obj.x + dx);
                    objMap.set('y', obj.y + dy);
                }
            });
        },
        [selectedObjectIds, deck.objects, yjsDoc],
    );
    const arrangeSelected = useCallback(
        (op: ArrangeOp) => {
            if (!yjsDoc) return;
            const objects = selectedObjectIds.map((id) => deck.objects[id]).filter(Boolean);
            const patches = computeArrange(objects, op);
            if (patches.length === 0) return;
            yjsDoc.transact(() => {
                const objectsMap = yjsDoc.getMap('objects');
                for (const patch of patches) {
                    const objMap = objectsMap.get(patch.id) as import('yjs').Map<unknown> | undefined;
                    if (!objMap) continue;
                    if (patch.x !== undefined) objMap.set('x', patch.x);
                    if (patch.y !== undefined) objMap.set('y', patch.y);
                    if (patch.w !== undefined) objMap.set('w', patch.w);
                    if (patch.h !== undefined) objMap.set('h', patch.h);
                }
            });
        },
        [selectedObjectIds, deck.objects, yjsDoc],
    );
    useHotkey(
        'ArrowLeft',
        (e) => {
            e.preventDefault();
            moveSelected(-1, 0);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowRight',
        (e) => {
            e.preventDefault();
            moveSelected(1, 0);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowUp',
        (e) => {
            e.preventDefault();
            moveSelected(0, -1);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowDown',
        (e) => {
            e.preventDefault();
            moveSelected(0, 1);
        },
        { enabled: canEdit && hasSelection && !isEditing },
    );
    const handleImageFile = useCallback(
        async (file: File) => {
            if (!activeSlideId || !mediaFolderId || !file.type.startsWith('image/')) return;
            const { pendingName, promise } = startUpload(file);
            const objId = addObject(activeSlideId, {
                ...DEFAULT_IMAGE_OBJECT,
                mediaName: pendingName,
            } as Omit<SlideObject, 'id' | 'slideId'>);
            if (!objId) return;
            const result = await promise;
            if (result) updateObject(objId, { mediaName: result.name });
            else deleteObject(objId);
        },
        [activeSlideId, mediaFolderId, startUpload, addObject, updateObject, deleteObject],
    );

    const handleImageFromDevice = useCallback(
        (files: File[]) => {
            const file = files[0];
            if (file) handleImageFile(file);
        },
        [handleImageFile],
    );

    const handleImagePickFromDrive = useCallback(
        async (paths: DrivePath[]) => {
            if (!activeSlideId || !mediaFolderId) return;
            const results = await copyToMediaFolder.mutateAsync({ paths, mediaFolderId }).catch(() => null);
            if (!results) return;
            for (const result of results) {
                addObject(activeSlideId, {
                    ...DEFAULT_IMAGE_OBJECT,
                    mediaName: result.name,
                } as Omit<SlideObject, 'id' | 'slideId'>);
            }
        },
        [activeSlideId, mediaFolderId, copyToMediaFolder, addObject],
    );

    useEffect(() => {
        if (isPresenting) return;
        const handleCopy = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable)
                return;
            if (selectedObjectIds.length === 0) return;
            const items = selectedObjectIds
                .map((id) => deck.objects[id])
                .filter(Boolean)
                .map((obj) => buildClipboardItem(obj, resolveMediaPath))
                .filter(Boolean) as EigenClipboardItem[];
            if (items.length === 0) return;
            e.preventDefault();
            const data: EigenClipboardData = { version: 1, items };
            const firstObj = selectedObjectIds.length === 1 ? deck.objects[selectedObjectIds[0]] : undefined;
            const textPreview = firstObj?.type === 'text' ? htmlToPlainText(firstObj.text) : undefined;
            writeEigenClipboard(e, data, textPreview);
        };
        const handlePaste = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable)
                return;
            if (!activeSlideId || !canWrite) return;

            const imageFile = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
            if (imageFile) {
                e.preventDefault();
                handleImageFile(imageFile);
                return;
            }

            const eigenData = e.clipboardData ? readEigenClipboard(e.clipboardData) : null;
            if (eigenData) {
                e.preventDefault();
                for (const item of eigenData.items) {
                    const m = item.meta ?? {};
                    if (item.type === 'text') {
                        const overrides: Record<string, unknown> = {};
                        if (m.x != null) overrides.x = m.x;
                        if (m.y != null) overrides.y = m.y;
                        for (const k of [
                            'w',
                            'h',
                            'rotation',
                            'borderColor',
                            'borderWidth',
                            'borderRadius',
                            'fontFamily',
                            'fontSize',
                            'fontWeight',
                            'fontStyle',
                            'textDecoration',
                            'textAlign',
                            'verticalAlign',
                            'color',
                            'letterSpacing',
                            'lineHeight',
                            'highlightColor',
                            'background',
                        ] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        addObject(activeSlideId, {
                            ...DEFAULT_TEXT_OBJECT,
                            text: item.text,
                            ...overrides,
                        } as Omit<SlideObject, 'id' | 'slideId'>);
                    } else if (item.type === 'image') {
                        const overrides: Record<string, unknown> = {};
                        if (m.x != null) overrides.x = m.x;
                        if (m.y != null) overrides.y = m.y;
                        for (const k of [
                            'w',
                            'h',
                            'rotation',
                            'borderColor',
                            'borderWidth',
                            'borderRadius',
                            'objectFit',
                        ] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        const imageProps = { ...DEFAULT_IMAGE_OBJECT, ...overrides };
                        if (needsReUpload(item.sourceParentId, mediaFolderId) && mediaFolderId) {
                            reUploadImage(
                                item.sourcePathId,
                                item.sourceOwnerId,
                                item.sourceMountId,
                                mediaFolderId,
                                uploadFile.mutateAsync,
                                ownerId,
                                path.mountId,
                                item.mediaName,
                            ).then((result) => {
                                // Re-upload failed: skip insertion, don't write the source deck's unresolvable mediaName.
                                if (!result) return;
                                addObject(activeSlideId, {
                                    ...imageProps,
                                    mediaName: result.mediaName,
                                } as Omit<ImageObject, 'id' | 'slideId'>);
                            });
                        } else {
                            addObject(activeSlideId, {
                                ...imageProps,
                                mediaName: item.mediaName,
                            } as Omit<ImageObject, 'id' | 'slideId'>);
                        }
                    }
                }
                return;
            }

            const text = e.clipboardData?.getData('text/plain') ?? '';
            if (text.trim()) {
                e.preventDefault();
                addObject(activeSlideId, {
                    ...DEFAULT_TEXT_OBJECT,
                    text: `<p>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</p>`,
                } as Omit<SlideObject, 'id' | 'slideId'>);
            }
        };
        document.addEventListener('copy', handleCopy);
        document.addEventListener('paste', handlePaste);
        return () => {
            document.removeEventListener('copy', handleCopy);
            document.removeEventListener('paste', handlePaste);
        };
    }, [
        selectedObjectIds,
        deck.objects,
        activeSlideId,
        canWrite,
        isPresenting,
        addObject,
        handleImageFile,
        resolveMediaPath,
        mediaFolderId,
        uploadFile.mutateAsync,
        ownerId,
        path.mountId,
    ]);

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload.
    const deckRef = useRef(deck);
    deckRef.current = deck;
    useEffect(() => {
        if (!isSynced) return;
        const snapshot: string[] = [];
        for (const obj of Object.values(deckRef.current.objects)) {
            if (obj.type === 'image' && isPendingMediaName(obj.mediaName)) {
                snapshot.push(obj.id);
            }
        }
        if (snapshot.length === 0) return;
        const timer = setTimeout(() => {
            for (const objId of snapshot) {
                const obj = deckRef.current.objects[objId];
                if (obj?.type === 'image' && isPendingMediaName(obj.mediaName)) {
                    deleteObject(objId);
                }
            }
        }, 60_000);
        return () => clearTimeout(timer);
    }, [isSynced, deleteObject]);

    const handleAddText = useCallback(() => {
        if (!activeSlideId) return;
        addObject(activeSlideId, DEFAULT_TEXT_OBJECT);
    }, [activeSlideId, addObject]);

    const handleStartEditing = useCallback((objId: string) => {
        setSelectedObjectIds([objId]);
        setEditingObjectId(objId);
    }, []);

    const handleCopyObject = useCallback(
        (objId: string) => {
            const obj = deck.objects[objId];
            if (!obj) return;
            const item = buildClipboardItem(obj, resolveMediaPath);
            if (!item) return;
            const data: EigenClipboardData = { version: 1, items: [item] };
            writeEigenClipboardAsync(data, obj.type === 'text' ? htmlToPlainText(obj.text) : undefined);
        },
        [deck.objects, resolveMediaPath],
    );

    const handleDeleteObject = useCallback(
        (objId: string) => {
            deleteObject(objId);
            setSelectedObjectIds((prev) => prev.filter((id) => id !== objId));
            setEditingObjectId((prev) => (prev === objId ? null : prev));
        },
        [deleteObject],
    );

    const handleDeleteSelectedObjects = useCallback(
        (ids: string[]) => {
            deleteObjects(ids);
            setSelectedObjectIds([]);
            setEditingObjectId((prev) => (prev && ids.includes(prev) ? null : prev));
        },
        [deleteObjects],
    );

    const handleSelectObject = useCallback(
        (id: string | null, additive?: boolean) => {
            if (!id) {
                setSelectedObjectIds([]);
                setEditingObjectId(null);
                return;
            }
            if (additive) {
                setSelectedObjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
                setEditingObjectId(null);
            } else {
                setSelectedObjectIds([id]);
                if (id !== editingObjectId) setEditingObjectId(null);
            }
        },
        [editingObjectId],
    );

    const handleDuplicateObjects = useCallback(
        (placements: { id: string; x: number; y: number }[]) => {
            const ids = duplicateObjects(placements);
            if (ids.length) setSelectedObjectIds(ids);
        },
        [duplicateObjects],
    );

    const handleDropImage = useCallback(
        (file: File) => {
            handleImageFile(file);
        },
        [handleImageFile],
    );

    const handleBackgroundImageUpload = useCallback(
        async (file: File): Promise<string | null> => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return null;
            const result = await uploadFile.mutateAsync({ parentId: mediaFolderId, file }).catch(() => null);
            return result?.name ?? null;
        },
        [mediaFolderId, uploadFile],
    );

    const handleBackgroundImagePickFromDrive = useCallback(
        async (paths: DrivePath[]) => {
            if (!mediaFolderId || !activeSlideId || paths.length === 0) return;
            const result = await copyToMediaFolder.mutateAsync({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            if (result?.[0]) {
                updateSlideBackground(
                    activeSlideId,
                    { type: 'image', mediaName: result[0].name, fit: 'cover' },
                    'this',
                );
            }
        },
        [mediaFolderId, activeSlideId, copyToMediaFolder, updateSlideBackground],
    );

    const handlePresent = useCallback(() => {
        setEditingObjectId(null);
        setIsPresenting(true);
        // No API (iOS Safari) or a rejected request still presents: the overlay is fixed inset-0.
        document.documentElement.requestFullscreen?.().catch(() => {});
    }, []);

    const handleAddComment = useCallback(
        (objId: string) => {
            const obj = deck.objects[objId];
            if (!obj) return;
            setAddTargetObjId(objId);
            setAddInitialTitle(obj.type === 'text' ? htmlToPlainText(obj.text).slice(0, 100) : 'Image');
            setAddOpen(true);
        },
        [deck.objects],
    );

    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            if (!addTargetObjId) return;
            const objId = addTargetObjId;
            const card = await createCard({ title: addInitialTitle, ...patch, attachments }, (card) => {
                addCommentToObject(objId, card.id);
            });
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setAddTargetObjId(null);
            setAddOpen(false);
        },
        [addTargetObjId, addInitialTitle, createCard, assignComment, addCommentToObject],
    );

    const activeSlide = activeSlideId ? deck.slides[activeSlideId] : null;
    const activeObjects = activeSlide ? activeSlide.objectIds.map((id) => deck.objects[id]).filter(Boolean) : [];
    const selectedObjects = useMemo(
        () => selectedObjectIds.map((id) => deck.objects[id]).filter(Boolean),
        [selectedObjectIds, deck.objects],
    );

    const slideBackgroundImageUrl =
        activeSlide?.background?.type === 'image' && activeSlide.background.mediaName
            ? resolveMediaUrl(activeSlide.background.mediaName)
            : null;

    // The properties/background/comment panel is a w-64 flex sibling on the right whenever there's an
    // active slide and the user can write (or comments are open) — inset the find bar clear of it.
    const rightPanelShown = !isMobile && !!activeSlide && (commentPanelOpen || activityPanelOpen || canWrite);

    if (!isSynced) return <LoadingState />;

    if (isPresenting && activeSlide) {
        return (
            <div
                // Full-screen present sits at the documented full-screen tier (z-100, like FilePreview),
                // not the portal tier, so it covers the app chrome instead of tying with it.
                className={cn(
                    'fixed inset-0 z-[100] flex items-center justify-center bg-black',
                    !presentControlsVisible && 'cursor-none',
                )}
                onPointerMove={revealPresentControls}
                onClick={() => {
                    revealPresentControls();
                    const currentIdx = deck.slideOrder.indexOf(activeSlideId!);
                    if (currentIdx < deck.slideOrder.length - 1) {
                        setActiveSlideId(deck.slideOrder[currentIdx + 1]);
                    } else {
                        exitPresent();
                    }
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
                    const currentIdx = deck.slideOrder.indexOf(activeSlideId!);
                    if (currentIdx > 0) {
                        setActiveSlideId(deck.slideOrder[currentIdx - 1]);
                    }
                }}
            >
                <div
                    className="relative w-full overflow-hidden"
                    style={{
                        aspectRatio: '16/9',
                        maxHeight: '100%',
                        containerType: 'size',
                        ...getBackgroundStyle(activeSlide.background, resolveMediaUrl),
                    }}
                >
                    {activeObjects.map((obj) => (
                        <ReadOnlySlideObject key={obj.id} obj={obj} />
                    ))}
                </div>
                <button
                    type="button"
                    title="Exit present (Esc)"
                    aria-label="Exit present"
                    tabIndex={presentControlsVisible ? undefined : -1}
                    // Hidden means gone, so a tap in this corner still advances the deck.
                    className={cn(
                        'absolute top-4 right-4 rounded-full bg-black/50 p-2.5 pointer-coarse:p-3 text-white transition-opacity hover:bg-black/70',
                        !presentControlsVisible && 'pointer-events-none opacity-0',
                    )}
                    onClick={(e) => {
                        e.stopPropagation();
                        exitPresent();
                    }}
                >
                    <X className="size-5" />
                </button>
            </div>
        );
    }

    return (
        <ColumnLayout>
            {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
            <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                <DocSearchProvider
                    controller={docSearchController}
                    initialSearchTerm={initialSearchTerm}
                    onOpenChange={handleSearchOpenChange}
                    // right-68 = panel width + the bar's own gutter.
                    barClassName={cn('top-14', rightPanelShown && 'right-68')}
                >
                    <Column
                        id={'editor'}
                        width={'w-full'}
                        className="flex-1 h-full"
                        toolbarBorder="always"
                        toolbar={
                            <Toolbar
                                path={path}
                                canWrite={canWrite}
                                undoManager={undoManager}
                                onAccessDialogOpen={onAccessDialogOpen}
                                onAddText={handleAddText}
                                onAddImage={() => setImagePickerOpen(true)}
                                onAddSlide={() => addSlide()}
                                onPresent={handlePresent}
                                // Always offered: desktop draws the side panel, mobile the Column.
                                onToggleCommentPanel={toggleComments}
                                commentPanelOpen={commentPanelOpen}
                                onToggleActivityPanel={toggleActivity}
                                activityPanelOpen={activityPanelOpen}
                                unresolvedCommentCount={unresolvedCount}
                            />
                        }
                    >
                        <div className="flex-1 flex overflow-hidden h-full">
                            <SlidePanel
                                deck={deck}
                                highlightedSlideIds={highlightedSlideIds}
                                activeSlideId={activeSlideId}
                                onSelectSlide={(id) => {
                                    setActiveSlideId(id);
                                    setSelectedObjectIds([]);
                                    setEditingObjectId(null);
                                }}
                                onDragStart={handleDragStart}
                                onDragEnd={handleDragEnd}
                                dragActiveId={dragState.activeId}
                                onDeleteSlide={canWrite ? deleteSlide : undefined}
                                onDuplicateSlide={canWrite ? duplicateSlide : undefined}
                                mobile={isMobile}
                            />
                            {!isMobile &&
                                (activeSlide ? (
                                    <div className="flex-1 flex overflow-hidden">
                                        <div className="flex-1 flex flex-col overflow-hidden">
                                            <SlideCanvas
                                                slide={activeSlide}
                                                objects={activeObjects}
                                                searchActiveObjectId={searchActiveObjectId}
                                                searchMatchedObjectIds={matchedObjectIds}
                                                selectedObjectIds={selectedObjectIds}
                                                editingObjectId={editingObjectId}
                                                onSelectObject={handleSelectObject}
                                                onSelectObjects={setSelectedObjectIds}
                                                onStartEditing={handleStartEditing}
                                                onUpdateObject={updateObject}
                                                onDuplicateObjects={canWrite ? handleDuplicateObjects : undefined}
                                                onDropImage={canWrite ? handleDropImage : undefined}
                                                onCopyObject={handleCopyObject}
                                                onDeleteObject={canWrite ? handleDeleteObject : undefined}
                                                onMoveUp={canWrite ? moveObjectUp : undefined}
                                                onMoveDown={canWrite ? moveObjectDown : undefined}
                                                onMoveToFront={canWrite ? moveObjectToFront : undefined}
                                                onMoveToBack={canWrite ? moveObjectToBack : undefined}
                                                canWrite={canWrite}
                                                onAddComment={canWrite && chatFolderId ? handleAddComment : undefined}
                                                onCommentClick={setOpenCardId}
                                                cards={cards}
                                                entries={allComments}
                                                members={members}
                                                currentUserEmail={auth.user?.email}
                                                onCommentAssign={(chatName, email, title) =>
                                                    assignComment.mutate({ chatName, assignee: email, title })
                                                }
                                                onCommentResolve={(chatName, title) =>
                                                    resolveComment.mutate({ chatName, status: 'resolved', title })
                                                }
                                                onCommentReopen={(chatName, title) =>
                                                    resolveComment.mutate({ chatName, status: 'open', title })
                                                }
                                                onCommentChangeColor={(cardId, color) => updateCard(cardId, { color })}
                                                onCommentDelete={removeCommentFromObject}
                                            />
                                            <div className="h-8 bg-muted border-t flex items-center justify-between px-4 text-xs text-muted-foreground">
                                                <span>
                                                    Slide {deck.slideOrder.indexOf(activeSlideId!) + 1} of{' '}
                                                    {deck.slideOrder.length}
                                                </span>
                                            </div>
                                        </div>
                                        {panel ? (
                                            <PanelColumn activePanel={panel} {...panelProps} />
                                        ) : selectedObjects.length > 0 && canWrite ? (
                                            <SlidePropertiesPanel
                                                objects={selectedObjects}
                                                onUpdate={updateObjects}
                                                onDelete={handleDeleteSelectedObjects}
                                                onArrange={arrangeSelected}
                                            />
                                        ) : canWrite && activeSlideId ? (
                                            <SlideBackgroundPanel
                                                background={activeSlide.background}
                                                backgroundImageUrl={slideBackgroundImageUrl}
                                                onUpdateBackground={(background, applyTo) =>
                                                    updateSlideBackground(activeSlideId!, background, applyTo)
                                                }
                                                onUploadImage={handleBackgroundImageUpload}
                                                onPickImageFromDrive={handleBackgroundImagePickFromDrive}
                                            />
                                        ) : null}
                                    </div>
                                ) : (
                                    <EmptyState message="No slides yet" />
                                ))}
                        </div>

                        {mediaFolderId && (
                            <DrivePickerWithUpload
                                open={imagePickerOpen}
                                onOpenChange={setImagePickerOpen}
                                title="Add image"
                                mimeFilter={['image/*']}
                                onPickFromDrive={handleImagePickFromDrive}
                                onPickFromDevice={handleImageFromDevice}
                                accept="image/*"
                            />
                        )}
                    </Column>
                </DocSearchProvider>
            </div>

            {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}

            <CardFormDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setAddTargetObjId(null);
                }}
                initialTitle={addInitialTitle}
                onSave={handleSaveNew}
                allowAttachments={!!mediaFolderId}
                members={members}
                currentUserEmail={auth.user?.email}
                dialogTitle="New comment"
                submitLabel="Add comment"
            />

            <CommentLifecycleDialogs
                lifecycle={lifecycle}
                path={path}
                canWrite={canWrite}
                commentContextMenu={commentContextMenu}
                onDelete={(cardId) => {
                    for (const obj of Object.values(deck.objects)) {
                        if (obj.commentCardIds?.includes(cardId)) {
                            removeCommentFromObject(obj.id, cardId);
                        }
                    }
                }}
            />
        </ColumnLayout>
    );
}
