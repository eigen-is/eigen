import {useCallback, useEffect, useRef, useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {useDeck} from './hooks/use-deck';
import {useSlideDnd} from './hooks/use-slide-dnd';
import {SlidePanel} from './slide-panel';
import {SlideCanvas} from './slide-canvas';
import {Toolbar} from './toolbar';
import {AddTextDialog} from './add-text-dialog';
import {ObjectSettingsDialog} from './object-settings-dialog';
import {SlideSettingsDialog} from './slide-settings-dialog';
import {DEFAULT_IMAGE_OBJECT, DEFAULT_TEXT_OBJECT, SlideObject} from './types';
import type {DrivePath} from '@workspace/lib/types/drive';
import {getDriveEmbedUrl} from '@workspace/lib/api';
import {useUploadFile} from '@workspace/lib/drive';
import * as Y from 'yjs';

const CLIPBOARD_MARKER = 'eigenslides:object:';

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
    const [isAddTextOpen, setIsAddTextOpen] = useState(false);
    const [isObjectSettingsOpen, setIsObjectSettingsOpen] = useState(false);
    const [isSlideSettingsOpen, setIsSlideSettingsOpen] = useState(false);
    const [isPresenting, setIsPresenting] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);

    const uploadFile = useUploadFile(ownerId, path.mountId);

    const isDialogOpen = isAddTextOpen || isObjectSettingsOpen || isSlideSettingsOpen;

    useHotkey('Mod+Z', (e) => { e.preventDefault(); undoManager?.undo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Y', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Shift+Z', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Delete', () => {
        if (selectedObjectId && canWrite) {
            deleteObject(selectedObjectId);
            setSelectedObjectId(null);
        }
    }, {enabled: canWrite && !!selectedObjectId && !isDialogOpen});
    useHotkey('Backspace', () => {
        if (selectedObjectId && canWrite) {
            deleteObject(selectedObjectId);
            setSelectedObjectId(null);
        }
    }, {enabled: canWrite && !!selectedObjectId && !isDialogOpen});
    useHotkey('Escape', () => {
        if (isPresenting) setIsPresenting(false);
        else setSelectedObjectId(null);
    }, {enabled: !isDialogOpen});
    const handleImageFile = useCallback(async (file: File) => {
        if (!activeSlideId || !mediaFolderId || !file.type.startsWith('image/')) return;
        try {
            const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
            if (result) {
                const src = getDriveEmbedUrl(path.ownerId, path.mountId, (result as any).id, 'image');
                addObject(activeSlideId, {...DEFAULT_IMAGE_OBJECT, src} as Omit<SlideObject, 'id' | 'slideId'>);
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

    useEffect(() => {
        const handleCopy = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;
            if (!selectedObjectId) return;
            const obj = deck.objects[selectedObjectId];
            if (!obj) return;
            e.preventDefault();
            e.clipboardData?.setData('text/plain', CLIPBOARD_MARKER + JSON.stringify(obj));
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

            const text = e.clipboardData?.getData('text/plain') ?? '';
            if (text.startsWith(CLIPBOARD_MARKER)) {
                e.preventDefault();
                try {
                    const obj = JSON.parse(text.slice(CLIPBOARD_MARKER.length)) as SlideObject;
                    const {id: _id, slideId: _sid, ...rest} = obj;
                    addObject(activeSlideId, {
                        ...rest,
                        x: rest.x + 2,
                        y: rest.y + 2
                    } as Omit<SlideObject, 'id' | 'slideId'>);
                } catch { /* not a valid slide object, ignore */
                }
                return;
            }

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
    }, [selectedObjectId, deck.objects, activeSlideId, canWrite, addObject, handleImageFile]);

    const handleAddText = useCallback((obj: typeof DEFAULT_TEXT_OBJECT & {text: string}) => {
        if (!activeSlideId) return;
        addObject(activeSlideId, obj);
    }, [activeSlideId, addObject]);


    const handleDoubleClickObject = useCallback((objId: string) => {
        setSelectedObjectId(objId);
        setIsObjectSettingsOpen(true);
    }, []);

    const handleCopyObject = useCallback((objId: string) => {
        const obj = deck.objects[objId];
        if (obj) navigator.clipboard.writeText(CLIPBOARD_MARKER + JSON.stringify(obj));
    }, [deck.objects]);

    const handleDeleteObject = useCallback((objId: string) => {
        deleteObject(objId);
        if (selectedObjectId === objId) setSelectedObjectId(null);
    }, [deleteObject, selectedObjectId]);

    const handleDropImage = useCallback(async (file: File) => {
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
    const selectedObject = selectedObjectId ? deck.objects[selectedObjectId] || null : null;

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
                onAddText={() => setIsAddTextOpen(true)}
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
                            onSelectObject={setSelectedObjectId}
                            onUpdateObject={updateObject}
                            onDoubleClickObject={handleDoubleClickObject}
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

            <AddTextDialog
                isOpen={isAddTextOpen}
                onClose={() => setIsAddTextOpen(false)}
                onAdd={handleAddText}
            />
            <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageSelect}
            />
            <ObjectSettingsDialog
                isOpen={isObjectSettingsOpen}
                onClose={() => setIsObjectSettingsOpen(false)}
                object={selectedObject}
                onUpdate={updateObject}
                onDelete={(objId) => { deleteObject(objId); setSelectedObjectId(null); }}
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
