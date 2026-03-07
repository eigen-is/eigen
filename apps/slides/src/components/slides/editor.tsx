import {useCallback, useEffect, useRef, useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {useDeck} from './hooks/use-deck';
import {useSlideDnd} from './hooks/use-slide-dnd';
import {SlidePanel} from './slide-panel';
import {SlideCanvas} from './slide-canvas';
import {Toolbar} from './toolbar';
import {SlideSettingsDialog} from './slide-settings-dialog';
import {DEFAULT_IMAGE_OBJECT, DEFAULT_TEXT_OBJECT, type ImageObject, SlideObject} from './types';
import type {DrivePath} from '@workspace/lib/types/drive';
import {getDriveEmbedUrl} from '@workspace/lib/api';
import {useUploadFile} from '@workspace/lib/drive';
import {
    needsReUpload,
    readEigenClipboard,
    reUploadImage,
    writeEigenClipboard,
    writeEigenClipboardAsync,
} from '@workspace/lib/clipboard';
import type {EigenClipboardData, EigenClipboardItem} from '@workspace/lib/types/clipboard';
import * as Y from 'yjs';

function buildClipboardItem(obj: SlideObject): EigenClipboardItem {
    const rect = {x: obj.x, y: obj.y, w: obj.w, h: obj.h, rotation: obj.rotation};
    if (obj.type === 'image') {
        return {type: 'image', src: obj.src, sourcePath: obj.sourcePath, meta: {...rect, objectFit: obj.objectFit}};
    }
    return {
        type: 'text',
        text: obj.text,
        meta: {
            ...rect,
            fontSize: obj.fontSize,
            fontWeight: obj.fontWeight,
            fontStyle: obj.fontStyle,
            textDecoration: obj.textDecoration,
            textAlign: obj.textAlign,
            color: obj.color
        }
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
}

export function SlideEditor({ownerId, path, canWrite, mediaFolderId, onAccessDialogOpen}: SlideEditorProps) {
    const {
        deck,
        activeSlideId,
        setActiveSlideId,
        addSlide,
        deleteSlide,
        duplicateSlide,
        updateSlideBackground,
        addObject,
        updateObject,
        deleteObject,
        yjsDoc,
        undoManager,
        moveObjectToFront,
        moveObjectToBack,
    } = useDeck(ownerId, path.mountId, path.id);

    const {dragState, handleDragStart, handleDragEnd} = useSlideDnd({deck, yjsDoc});

    const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
    const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
    const [isSlideSettingsOpen, setIsSlideSettingsOpen] = useState(false);
    const [isPresenting, setIsPresenting] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);

    const uploadFile = useUploadFile(ownerId, path.mountId);

    const isEditing = editingObjectId !== null;
    const isDialogOpen = isSlideSettingsOpen;

    useHotkey('Mod+Z', (e) => { e.preventDefault(); undoManager?.undo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Y', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Shift+Z', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Delete', () => {
        if (selectedObjectId && canWrite) {
            deleteObject(selectedObjectId);
            setSelectedObjectId(null);
        }
    }, {enabled: canWrite && !!selectedObjectId && !isDialogOpen && !isEditing});
    useHotkey('Backspace', () => {
        if (selectedObjectId && canWrite) {
            deleteObject(selectedObjectId);
            setSelectedObjectId(null);
        }
    }, {enabled: canWrite && !!selectedObjectId && !isDialogOpen && !isEditing});
    useHotkey('Escape', () => {
        if (isPresenting) setIsPresenting(false);
        else if (isEditing) setEditingObjectId(null);
        else setSelectedObjectId(null);
    }, {enabled: !isDialogOpen});
    const handleImageFile = useCallback(async (file: File) => {
        if (!activeSlideId || !mediaFolderId || !file.type.startsWith('image/')) return;
        try {
            const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
            if (result) {
                const src = getDriveEmbedUrl(path.ownerId, path.mountId, result.id, 'image');
                addObject(activeSlideId, {
                    ...DEFAULT_IMAGE_OBJECT,
                    src,
                    sourcePath: result,
                } as Omit<SlideObject, 'id' | 'slideId'>);
            }
        } catch (e) {
            console.error('Image upload failed:', e);
        }
    }, [activeSlideId, mediaFolderId, uploadFile, path.ownerId, path.mountId, addObject]);

    const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleImageFile(file);
        e.target.value = '';
    }, [handleImageFile]);

    const handleReUploadImage = useCallback(async (srcUrl: string) => {
        if (!mediaFolderId) return null;
        return reUploadImage(srcUrl, mediaFolderId, uploadFile.mutateAsync, path.ownerId, path.mountId);
    }, [mediaFolderId, uploadFile.mutateAsync, path.ownerId, path.mountId]);

    useEffect(() => {
        const handleCopy = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;
            if (!selectedObjectId) return;
            const obj = deck.objects[selectedObjectId];
            if (!obj) return;
            e.preventDefault();
            const data: EigenClipboardData = {version: 1, items: [buildClipboardItem(obj)]};
            writeEigenClipboard(e, data, obj.type === 'text' ? obj.text : undefined);
        };
        const handlePaste = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;
            if (!activeSlideId || !canWrite) return;

            const imageFile = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'));
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
                        if (m.x != null) overrides.x = (m.x as number) + 2;
                        if (m.y != null) overrides.y = (m.y as number) + 2;
                        for (const k of ['w', 'h', 'rotation', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'textAlign', 'color'] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        addObject(activeSlideId, {
                            ...DEFAULT_TEXT_OBJECT,
                            text: item.text, ...overrides
                        } as Omit<SlideObject, 'id' | 'slideId'>);
                    } else if (item.type === 'image') {
                        const overrides: Record<string, unknown> = {};
                        if (m.x != null) overrides.x = (m.x as number) + 2;
                        if (m.y != null) overrides.y = (m.y as number) + 2;
                        for (const k of ['w', 'h', 'rotation', 'objectFit'] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        const imageProps = {...DEFAULT_IMAGE_OBJECT, ...overrides};
                        if (needsReUpload(item.sourcePath, mediaFolderId)) {
                            handleReUploadImage(item.src).then((result) => {
                                addObject(activeSlideId, {
                                    ...imageProps,
                                    src: result?.src ?? item.src,
                                    sourcePath: result?.sourcePath ?? item.sourcePath,
                                } as Omit<ImageObject, 'id' | 'slideId'>);
                            });
                        } else {
                            addObject(activeSlideId, {
                                ...imageProps,
                                src: item.src,
                                sourcePath: item.sourcePath,
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
    }, [selectedObjectId, deck.objects, activeSlideId, canWrite, addObject, handleImageFile, handleReUploadImage, mediaFolderId]);

    const handleAddText = useCallback(() => {
        if (!activeSlideId) return;
        addObject(activeSlideId, DEFAULT_TEXT_OBJECT);
    }, [activeSlideId, addObject]);

    const handleStartEditing = useCallback((objId: string) => {
        setSelectedObjectId(objId);
        setEditingObjectId(objId);
    }, []);

    const handleStopEditing = useCallback(() => {
        setEditingObjectId(null);
    }, []);

    const handleCopyObject = useCallback((objId: string) => {
        const obj = deck.objects[objId];
        if (!obj) return;
        const data: EigenClipboardData = {version: 1, items: [buildClipboardItem(obj)]};
        writeEigenClipboardAsync(data, obj.type === 'text' ? obj.text : undefined);
    }, [deck.objects]);

    const handleDeleteObject = useCallback((objId: string) => {
        deleteObject(objId);
        if (selectedObjectId === objId) setSelectedObjectId(null);
    }, [deleteObject, selectedObjectId]);

    const handleDropImage = useCallback((file: File) => {
        handleImageFile(file);
    }, [handleImageFile]);

    const handlePresent = useCallback(() => {
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().then(() => setIsPresenting(true));
        }
    }, []);

    const handleRestore = useCallback((state: Uint8Array) => {
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
    }, [yjsDoc]);

    const activeSlide = activeSlideId ? deck.slides[activeSlideId] : null;
    const activeObjects = activeSlide
        ? activeSlide.objectIds.map(id => deck.objects[id]).filter(Boolean)
        : [];

    if (isPresenting && activeSlide) {
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
                    className="w-full h-full relative"
                    style={{
                        aspectRatio: '16/9',
                        maxWidth: '100vw',
                        maxHeight: '100vh',
                        backgroundColor: activeSlide.backgroundColor,
                    }}
                >
                    {activeObjects.map((obj) => (
                        <div
                            key={obj.id}
                            className="absolute"
                            style={{
                                left: `${obj.x}%`,
                                top: `${obj.y}%`,
                                width: `${obj.w}%`,
                                height: `${obj.h}%`,
                                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
                            }}
                        >
                            {obj.type === 'text' && (
                                <p
                                    className="whitespace-pre-wrap break-words w-full h-full flex items-center"
                                    style={{
                                        fontSize: `${obj.fontSize / 1080 * 100}vh`,
                                        fontWeight: obj.fontWeight,
                                        fontStyle: obj.fontStyle,
                                        textDecoration: obj.textDecoration !== 'none' ? obj.textDecoration : undefined,
                                        textAlign: obj.textAlign,
                                        color: obj.color,
                                        justifyContent: obj.textAlign === 'center' ? 'center' : obj.textAlign === 'right' ? 'flex-end' : 'flex-start',
                                        lineHeight: 1.2,
                                    }}
                                >
                                    {obj.text}
                                </p>
                            )}
                            {obj.type === 'image' && (
                                <img src={obj.src} className="w-full h-full" style={{objectFit: obj.objectFit}} draggable={false} alt=""/>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full w-full">
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
            <div className="flex-1 flex overflow-hidden">
                <SlidePanel
                    deck={deck}
                    activeSlideId={activeSlideId}
                    onSelectSlide={(id) => { setActiveSlideId(id); setSelectedObjectId(null); }}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    dragActiveId={dragState.activeId}
                    onDeleteSlide={canWrite ? deleteSlide : undefined}
                    onDuplicateSlide={canWrite ? duplicateSlide : undefined}
                />
                {activeSlide ? (
                    <div className="flex-1 flex flex-col overflow-hidden">
                        <SlideCanvas
                            slide={activeSlide}
                            objects={activeObjects}
                            selectedObjectId={selectedObjectId}
                            editingObjectId={editingObjectId}
                            onSelectObject={(id) => {
                                setSelectedObjectId(id);
                                if (id !== editingObjectId) setEditingObjectId(null);
                            }}
                            onStartEditing={handleStartEditing}
                            onStopEditing={handleStopEditing}
                            onUpdateObject={updateObject}
                            onDropImage={canWrite ? handleDropImage : undefined}
                            onCopyObject={handleCopyObject}
                            onDeleteObject={canWrite ? handleDeleteObject : undefined}
                            onMoveToFront={canWrite ? moveObjectToFront : undefined}
                            onMoveToBack={canWrite ? moveObjectToBack : undefined}
                            canWrite={canWrite}
                        />
                        <div className="h-8 bg-muted border-t flex items-center justify-between px-4 text-xs text-muted-foreground">
                            <span>Slide {deck.slideOrder.indexOf(activeSlideId!) + 1} of {deck.slideOrder.length}</span>
                            {canWrite && (
                                <button
                                    className="hover:underline"
                                    onClick={() => setIsSlideSettingsOpen(true)}
                                >
                                    Slide settings
                                </button>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        No slides yet
                    </div>
                )}
            </div>

            <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageSelect}
            />
            {activeSlideId && activeSlide && (
                <SlideSettingsDialog
                    isOpen={isSlideSettingsOpen}
                    onClose={() => setIsSlideSettingsOpen(false)}
                    slideId={activeSlideId}
                    currentBackground={activeSlide.backgroundColor}
                    onUpdateBackground={updateSlideBackground}
                    onDeleteSlide={deleteSlide}
                    onDuplicateSlide={duplicateSlide}
                    slideCount={deck.slideOrder.length}
                />
            )}
        </div>
    );
}
