import { useHotkey } from '@tanstack/react-hotkeys';
import {
    needsReUpload,
    readEigenClipboard,
    reUploadImage,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import { MediaResolverProvider, useMediaResolver, useUploadFile } from '@workspace/lib/drive';
import type { EigenClipboardData, EigenClipboardItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { Column, ColumnLayout, EmptyState } from '@workspace/ui/index';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useDeck } from './hooks/use-deck';
import { useSlideDnd } from './hooks/use-slide-dnd';
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
            backgroundColor: obj.backgroundColor,
        },
    };
}

function jsonToYType(value: unknown): unknown {
    if (Array.isArray(value)) {
        const arr = new Y.Array();
        arr.push(value.map(jsonToYType));
        return arr;
    }
    if (value !== null && typeof value === 'object') {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            map.set(k, jsonToYType(v));
        }
        return map;
    }
    return value;
}

type SlideEditorProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    onAccessDialogOpen: () => void;
};

export function SlideEditor({ ownerId, path, canWrite, mediaFolderId, onAccessDialogOpen }: SlideEditorProps) {
    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={null}
        >
            <SlideEditorInner
                ownerId={ownerId}
                path={path}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                onAccessDialogOpen={onAccessDialogOpen}
            />
        </MediaResolverProvider>
    );
}

function SlideEditorInner({ ownerId, path, canWrite, mediaFolderId, onAccessDialogOpen }: SlideEditorProps) {
    const {
        deck,
        activeSlideId,
        setActiveSlideId,
        addSlide,
        deleteSlide,
        duplicateSlide,
        updateSlideBackground,
        updateSlideBackgroundImage,
        addObject,
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
    } = useDeck(ownerId, path.mountId, path.id);

    const { isMobile } = useLayout();
    const { resolveMediaUrl, resolveMediaPath } = useMediaResolver();
    const { dragState, handleDragStart, handleDragEnd } = useSlideDnd({ deck, yjsDoc });

    const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
    const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
    const [isPresenting, setIsPresenting] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);

    const uploadFile = useUploadFile(ownerId, path.mountId);

    const hasSelection = selectedObjectIds.length > 0;
    const isEditing = editingObjectId !== null;

    useHotkey(
        'Mod+Z',
        (e) => {
            e.preventDefault();
            undoManager?.undo();
        },
        { enabled: canWrite && !!undoManager },
    );
    useHotkey(
        'Mod+Y',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled: canWrite && !!undoManager },
    );
    useHotkey(
        'Mod+Shift+Z',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled: canWrite && !!undoManager },
    );
    useHotkey(
        'Delete',
        () => {
            if (hasSelection && canWrite) {
                deleteObjects(selectedObjectIds);
                setSelectedObjectIds([]);
            }
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    useHotkey(
        'Backspace',
        () => {
            if (hasSelection && canWrite) {
                deleteObjects(selectedObjectIds);
                setSelectedObjectIds([]);
            }
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    useHotkey(
        'Escape',
        () => {
            if (isPresenting) setIsPresenting(false);
            else if (isEditing) setEditingObjectId(null);
            else setSelectedObjectIds([]);
        },
        { enabled: true },
    );
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
    useHotkey(
        'ArrowLeft',
        (e) => {
            e.preventDefault();
            moveSelected(-1, 0);
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowRight',
        (e) => {
            e.preventDefault();
            moveSelected(1, 0);
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowUp',
        (e) => {
            e.preventDefault();
            moveSelected(0, -1);
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    useHotkey(
        'ArrowDown',
        (e) => {
            e.preventDefault();
            moveSelected(0, 1);
        },
        { enabled: canWrite && hasSelection && !isEditing },
    );
    const handleImageFile = useCallback(
        async (file: File) => {
            if (!activeSlideId || !mediaFolderId || !file.type.startsWith('image/')) return;
            try {
                const result = await uploadFile.mutateAsync({ parentId: mediaFolderId, file });
                if (result) {
                    addObject(activeSlideId, {
                        ...DEFAULT_IMAGE_OBJECT,
                        mediaName: result.name,
                    } as Omit<SlideObject, 'id' | 'slideId'>);
                }
            } catch (e) {
                console.error('Image upload failed:', e);
            }
        },
        [activeSlideId, mediaFolderId, uploadFile, addObject],
    );

    const handleImageSelect = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) handleImageFile(file);
            e.target.value = '';
        },
        [handleImageFile],
    );

    useEffect(() => {
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
            const textPreview = firstObj?.type === 'text' ? firstObj.text : undefined;
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
                            'backgroundColor',
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
                                addObject(activeSlideId, {
                                    ...imageProps,
                                    mediaName: result?.mediaName ?? item.mediaName,
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
                    text: text.trim(),
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
        addObject,
        handleImageFile,
        resolveMediaPath,
        mediaFolderId,
        uploadFile.mutateAsync,
        ownerId,
        path.mountId,
    ]);

    const handleAddText = useCallback(() => {
        if (!activeSlideId) return;
        addObject(activeSlideId, DEFAULT_TEXT_OBJECT);
    }, [activeSlideId, addObject]);

    const handleStartEditing = useCallback((objId: string) => {
        setSelectedObjectIds([objId]);
        setEditingObjectId(objId);
    }, []);

    const handleStopEditing = useCallback(() => {
        setEditingObjectId(null);
    }, []);

    const handleCopyObject = useCallback(
        (objId: string) => {
            const obj = deck.objects[objId];
            if (!obj) return;
            const item = buildClipboardItem(obj, resolveMediaPath);
            if (!item) return;
            const data: EigenClipboardData = { version: 1, items: [item] };
            writeEigenClipboardAsync(data, obj.type === 'text' ? obj.text : undefined);
        },
        [deck.objects, resolveMediaPath],
    );

    const handleDeleteObject = useCallback(
        (objId: string) => {
            deleteObject(objId);
            setSelectedObjectIds((prev) => prev.filter((id) => id !== objId));
        },
        [deleteObject],
    );

    const handleDeleteSelectedObjects = useCallback(
        (ids: string[]) => {
            deleteObjects(ids);
            setSelectedObjectIds([]);
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

    const handleDropImage = useCallback(
        (file: File) => {
            handleImageFile(file);
        },
        [handleImageFile],
    );

    const handleBackgroundImageUpload = useCallback(
        async (file: File): Promise<string | null> => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return null;
            try {
                const result = await uploadFile.mutateAsync({ parentId: mediaFolderId, file });
                if (result) return result.name;
            } catch (e) {
                console.error('Background image upload failed:', e);
            }
            return null;
        },
        [mediaFolderId, uploadFile],
    );

    const handlePresent = useCallback(() => {
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().then(() => setIsPresenting(true));
        }
    }, []);

    const handleRestore = useCallback(
        (state: Uint8Array) => {
            if (!yjsDoc) return;
            const tempDoc = new Y.Doc();
            Y.applyUpdate(tempDoc, state);

            const allKeys = new Set([...yjsDoc.share.keys(), ...tempDoc.share.keys()]);

            yjsDoc.transact(() => {
                for (const key of allKeys) {
                    const localType = yjsDoc.get(key);
                    if (localType instanceof Y.Map) {
                        const json = tempDoc.getMap(key).toJSON();
                        for (const k of [...localType.keys()]) localType.delete(k);
                        for (const [k, v] of Object.entries(json)) {
                            localType.set(k, jsonToYType(v));
                        }
                    } else if (localType instanceof Y.Array) {
                        const json = tempDoc.getArray(key).toJSON();
                        localType.delete(0, localType.length);
                        localType.push(json);
                    }
                }
            });
            tempDoc.destroy();
        },
        [yjsDoc],
    );

    const activeSlide = activeSlideId ? deck.slides[activeSlideId] : null;
    const activeObjects = activeSlide ? activeSlide.objectIds.map((id) => deck.objects[id]).filter(Boolean) : [];
    const selectedObjects = useMemo(
        () => selectedObjectIds.map((id) => deck.objects[id]).filter(Boolean),
        [selectedObjectIds, deck.objects],
    );

    const backgroundImageUrl = activeSlide?.backgroundMediaName
        ? resolveMediaUrl(activeSlide.backgroundMediaName)
        : null;

    if (isPresenting && activeSlide) {
        const bgUrl = activeSlide.backgroundMediaName ? resolveMediaUrl(activeSlide.backgroundMediaName) : null;
        return (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black cursor-none"
                onClick={() => {
                    const currentIdx = deck.slideOrder.indexOf(activeSlideId!);
                    if (currentIdx < deck.slideOrder.length - 1) {
                        setActiveSlideId(deck.slideOrder[currentIdx + 1]);
                    } else {
                        setIsPresenting(false);
                        if (document.fullscreenElement) document.exitFullscreen();
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
                        backgroundColor: activeSlide.backgroundColor,
                        ...(bgUrl
                            ? {
                                  backgroundImage: `url(${bgUrl})`,
                                  backgroundSize: 'cover',
                                  backgroundPosition: 'center',
                              }
                            : {}),
                    }}
                >
                    {activeObjects.map((obj) => (
                        <ReadOnlySlideObject key={obj.id} obj={obj} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <ColumnLayout mobileColumn="editor">
            <Column
                id={'editor'}
                width={'w-full'}
                className="flex-1 h-full"
                toolbar={
                    <Toolbar
                        path={path}
                        canWrite={canWrite}
                        undoManager={undoManager}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onRestore={handleRestore}
                        onAddText={handleAddText}
                        onAddImage={() => imageInputRef.current?.click()}
                        onAddSlide={() => addSlide()}
                        onPresent={handlePresent}
                    />
                }
            >
                <div className="flex-1 flex overflow-hidden h-full">
                    <SlidePanel
                        deck={deck}
                        activeSlideId={activeSlideId}
                        onSelectSlide={(id) => {
                            setActiveSlideId(id);
                            setSelectedObjectIds([]);
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
                                        selectedObjectIds={selectedObjectIds}
                                        editingObjectId={editingObjectId}
                                        onSelectObject={handleSelectObject}
                                        onSelectObjects={setSelectedObjectIds}
                                        onStartEditing={handleStartEditing}
                                        onStopEditing={handleStopEditing}
                                        onUpdateObject={updateObject}
                                        onDropImage={canWrite ? handleDropImage : undefined}
                                        onCopyObject={handleCopyObject}
                                        onDeleteObject={canWrite ? handleDeleteObject : undefined}
                                        onMoveUp={canWrite ? moveObjectUp : undefined}
                                        onMoveDown={canWrite ? moveObjectDown : undefined}
                                        onMoveToFront={canWrite ? moveObjectToFront : undefined}
                                        onMoveToBack={canWrite ? moveObjectToBack : undefined}
                                        canWrite={canWrite}
                                    />
                                    <div className="h-8 bg-muted border-t flex items-center justify-between px-4 text-xs text-muted-foreground">
                                        <span>
                                            Slide {deck.slideOrder.indexOf(activeSlideId!) + 1} of{' '}
                                            {deck.slideOrder.length}
                                        </span>
                                    </div>
                                </div>
                                {selectedObjects.length > 0 && canWrite ? (
                                    <SlidePropertiesPanel
                                        objects={selectedObjects}
                                        onUpdate={updateObjects}
                                        onDelete={handleDeleteSelectedObjects}
                                    />
                                ) : canWrite && activeSlideId ? (
                                    <SlideBackgroundPanel
                                        currentBackground={activeSlide.backgroundColor}
                                        currentBackgroundMediaName={activeSlide.backgroundMediaName}
                                        currentBackgroundImageUrl={backgroundImageUrl}
                                        onUpdateBackground={(
                                            color: string,
                                            applyTo: 'this' | 'this-and-following' | 'all',
                                        ) => updateSlideBackground(activeSlideId!, color, applyTo)}
                                        onUpdateBackgroundImage={(
                                            mediaName: string,
                                            applyTo: 'this' | 'this-and-following' | 'all',
                                        ) => updateSlideBackgroundImage(activeSlideId!, mediaName, applyTo)}
                                        onUploadImage={handleBackgroundImageUpload}
                                    />
                                ) : null}
                            </div>
                        ) : (
                            <EmptyState message="No slides yet" />
                        ))}
                </div>

                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageSelect}
                />
            </Column>
        </ColumnLayout>
    );
}
