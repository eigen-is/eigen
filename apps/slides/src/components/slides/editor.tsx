import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {useDeck} from './hooks/use-deck';
import {useSlideDnd} from './hooks/use-slide-dnd';
import {SlidePanel} from './slide-panel';
import {SlideCanvas} from './slide-canvas';
import {SlidePropertiesPanel} from './slide-properties-panel';
import {Toolbar} from './toolbar';
import {SlideSettingsDialog} from './slide-settings-dialog';
import {DEFAULT_IMAGE_OBJECT, DEFAULT_TEXT_OBJECT, type ImageObject, SlideObject, pxToPercent, type DeckData} from './types';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {Button} from '@workspace/ui/components/button';
import {ImageIcon, Trash2} from 'lucide-react';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
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
    const shadow = {shadowColor: obj.shadowColor, shadowBlur: obj.shadowBlur, shadowOffsetX: obj.shadowOffsetX, shadowOffsetY: obj.shadowOffsetY};
    if (obj.type === 'image') {
        return {type: 'image', src: obj.src, sourcePath: obj.sourcePath, meta: {...rect, ...shadow, objectFit: obj.objectFit}};
    }
    return {
        type: 'text',
        text: obj.text,
        meta: {
            ...rect,
            ...shadow,
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

    const {dragState, handleDragStart, handleDragEnd} = useSlideDnd({deck, yjsDoc});

    const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
    const [editingObjectId, setEditingObjectId] = useState<string | null>(null);
    const [isSlideSettingsOpen, setIsSlideSettingsOpen] = useState(false);
    const [isPresenting, setIsPresenting] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);

    const uploadFile = useUploadFile(ownerId, path.mountId);

    const hasSelection = selectedObjectIds.length > 0;
    const isEditing = editingObjectId !== null;
    const isDialogOpen = isSlideSettingsOpen;

    useHotkey('Mod+Z', (e) => { e.preventDefault(); undoManager?.undo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Y', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Mod+Shift+Z', (e) => { e.preventDefault(); undoManager?.redo(); }, {enabled: canWrite && !!undoManager});
    useHotkey('Delete', () => {
        if (hasSelection && canWrite) {
            deleteObjects(selectedObjectIds);
            setSelectedObjectIds([]);
        }
    }, {enabled: canWrite && hasSelection && !isDialogOpen && !isEditing});
    useHotkey('Backspace', () => {
        if (hasSelection && canWrite) {
            deleteObjects(selectedObjectIds);
            setSelectedObjectIds([]);
        }
    }, {enabled: canWrite && hasSelection && !isDialogOpen && !isEditing});
    useHotkey('Escape', () => {
        if (isPresenting) setIsPresenting(false);
        else if (isEditing) setEditingObjectId(null);
        else setSelectedObjectIds([]);
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

    const handleReUploadImage = useCallback(async (srcUrl: string, sourcePath?: DrivePath) => {
        if (!mediaFolderId) return null;
        return reUploadImage(srcUrl, mediaFolderId, uploadFile.mutateAsync, path.ownerId, path.mountId, sourcePath);
    }, [mediaFolderId, uploadFile.mutateAsync, path.ownerId, path.mountId]);

    useEffect(() => {
        const handleCopy = (e: ClipboardEvent) => {
            const tag = (document.activeElement?.tagName ?? '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) return;
            if (selectedObjectIds.length === 0) return;
            const items = selectedObjectIds.map(id => deck.objects[id]).filter(Boolean).map(buildClipboardItem);
            if (items.length === 0) return;
            e.preventDefault();
            const data: EigenClipboardData = {version: 1, items};
            const textPreview = selectedObjectIds.length === 1 && deck.objects[selectedObjectIds[0]]?.type === 'text'
                ? (deck.objects[selectedObjectIds[0]] as any).text as string
                : undefined;
            writeEigenClipboard(e, data, textPreview);
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
                        if (m.x != null) overrides.x = m.x;
                        if (m.y != null) overrides.y = m.y;
                        for (const k of ['w', 'h', 'rotation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration', 'textAlign', 'verticalAlign', 'color', 'letterSpacing', 'lineHeight', 'highlightColor', 'backgroundColor'] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        addObject(activeSlideId, {
                            ...DEFAULT_TEXT_OBJECT,
                            text: item.text, ...overrides
                        } as Omit<SlideObject, 'id' | 'slideId'>);
                    } else if (item.type === 'image') {
                        const overrides: Record<string, unknown> = {};
                        if (m.x != null) overrides.x = m.x;
                        if (m.y != null) overrides.y = m.y;
                        for (const k of ['w', 'h', 'rotation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'objectFit'] as const) {
                            if (m[k] != null) overrides[k] = m[k];
                        }
                        const imageProps = {...DEFAULT_IMAGE_OBJECT, ...overrides};
                        if (needsReUpload(item.sourcePath, mediaFolderId)) {
                            handleReUploadImage(item.src, item.sourcePath).then((result) => {
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
    }, [selectedObjectIds, deck.objects, activeSlideId, canWrite, addObject, handleImageFile, handleReUploadImage, mediaFolderId]);

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

    const handleCopyObject = useCallback((objId: string) => {
        const obj = deck.objects[objId];
        if (!obj) return;
        const data: EigenClipboardData = {version: 1, items: [buildClipboardItem(obj)]};
        writeEigenClipboardAsync(data, obj.type === 'text' ? obj.text : undefined);
    }, [deck.objects]);

    const handleDeleteObject = useCallback((objId: string) => {
        deleteObject(objId);
        setSelectedObjectIds(prev => prev.filter(id => id !== objId));
    }, [deleteObject]);

    const handleDeleteSelectedObjects = useCallback((ids: string[]) => {
        deleteObjects(ids);
        setSelectedObjectIds([]);
    }, [deleteObjects]);

    const handleSelectObject = useCallback((id: string | null, additive?: boolean) => {
        if (!id) {
            setSelectedObjectIds([]);
            setEditingObjectId(null);
            return;
        }
        if (additive) {
            setSelectedObjectIds(prev =>
                prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
            );
            setEditingObjectId(null);
        } else {
            setSelectedObjectIds([id]);
            if (id !== editingObjectId) setEditingObjectId(null);
        }
    }, [editingObjectId]);

    const handleDropImage = useCallback((file: File) => {
        handleImageFile(file);
    }, [handleImageFile]);

    const handleBackgroundImageUpload = useCallback(async (file: File): Promise<{src: string; sourcePath: DrivePath} | null> => {
        if (!mediaFolderId || !file.type.startsWith('image/')) return null;
        try {
            const result = await uploadFile.mutateAsync({parentId: mediaFolderId, file});
            if (result) {
                return {
                    src: getDriveEmbedUrl(path.ownerId, path.mountId, result.id, 'image'),
                    sourcePath: result,
                };
            }
        } catch (e) {
            console.error('Background image upload failed:', e);
        }
        return null;
    }, [mediaFolderId, uploadFile, path.ownerId, path.mountId]);

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
    const selectedObjects = useMemo(
        () => selectedObjectIds.map(id => deck.objects[id]).filter(Boolean),
        [selectedObjectIds, deck.objects]
    );

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
                        ...(activeSlide.backgroundImage ? {backgroundImage: `url(${activeSlide.backgroundImage})`, backgroundSize: 'cover', backgroundPosition: 'center'} : {}),
                    }}
                >
                    {activeObjects.map((obj) => {
                        const shadow = (obj.shadowBlur || obj.shadowOffsetX || obj.shadowOffsetY) && obj.shadowColor && obj.shadowColor !== 'rgba(0,0,0,0)'
                            ? `${obj.shadowOffsetX}px ${obj.shadowOffsetY}px ${obj.shadowBlur}px ${obj.shadowColor}` : undefined;
                        const vAlign = obj.type === 'text' ? (obj.verticalAlign || 'top') : undefined;
                        return (
                        <div
                            key={obj.id}
                            className="absolute"
                            style={{
                                left: `${pxToPercent(obj.x, 'x')}%`,
                                top: `${pxToPercent(obj.y, 'y')}%`,
                                width: `${pxToPercent(obj.w, 'x')}%`,
                                height: `${pxToPercent(obj.h, 'y')}%`,
                                transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
                                transformOrigin: 'center center',
                                backgroundColor: obj.type === 'text' && obj.backgroundColor ? obj.backgroundColor : undefined,
                                ...(obj.type === 'image' && shadow ? {boxShadow: shadow} : {}),
                            }}
                        >
                            {obj.type === 'text' && (
                                <div
                                    className="w-full h-full flex"
                                    style={{
                                        alignItems: vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start',
                                    }}
                                >
                                    <p
                                        className="whitespace-pre-wrap break-words w-full"
                                        style={{
                                            fontSize: `${obj.fontSize / 1080 * 100}vh`,
                                            fontWeight: obj.fontWeight,
                                            fontStyle: obj.fontStyle,
                                            textDecoration: obj.textDecoration !== 'none' ? obj.textDecoration : undefined,
                                            textAlign: obj.textAlign,
                                            color: obj.color,
                                            lineHeight: obj.lineHeight || 1.2,
                                            letterSpacing: obj.letterSpacing ? `${obj.letterSpacing}px` : undefined,
                                            textShadow: shadow,
                                        }}
                                    >
                                        {obj.highlightColor
                                            ? <span style={{backgroundColor: obj.highlightColor, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone'}}>{obj.text}</span>
                                            : obj.text
                                        }
                                    </p>
                                </div>
                            )}
                            {obj.type === 'image' && (
                                <img src={obj.src} className="w-full h-full" style={{objectFit: obj.objectFit}} draggable={false} alt=""/>
                            )}
                        </div>
                        );
                    })}
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
                    onSelectSlide={(id) => { setActiveSlideId(id); setSelectedObjectIds([]); }}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    dragActiveId={dragState.activeId}
                    onDeleteSlide={canWrite ? deleteSlide : undefined}
                    onDuplicateSlide={canWrite ? duplicateSlide : undefined}
                />
                {activeSlide ? (
                    <div className="flex-1 flex overflow-hidden">
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <SlideCanvas
                                slide={activeSlide}
                                objects={activeObjects}
                                selectedObjectIds={selectedObjectIds}
                                editingObjectId={editingObjectId}
                                onSelectObject={handleSelectObject}
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
                        {selectedObjects.length > 0 && canWrite ? (
                            <SlidePropertiesPanel
                                objects={selectedObjects}
                                onUpdate={updateObjects}
                                onDelete={handleDeleteSelectedObjects}
                            />
                        ) : canWrite && activeSlideId ? (
                            <SlideBackgroundPanel
                                deck={deck}
                                activeSlideId={activeSlideId!}
                                currentBackground={activeSlide.backgroundColor}
                                currentBackgroundImage={activeSlide.backgroundImage}
                                currentBackgroundImageSourcePath={activeSlide.backgroundImageSourcePath}
                                onUpdateBackground={(color, applyTo) => updateSlideBackground(activeSlideId!, color, applyTo)}
                                onUpdateBackgroundImage={(url, sourcePath, applyTo) => updateSlideBackgroundImage(activeSlideId!, url, sourcePath, applyTo)}
                                onUploadImage={handleBackgroundImageUpload}
                            />
                        ) : null}
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
                    currentBackgroundImage={activeSlide.backgroundImage}
                    onUpdateBackground={updateSlideBackground}
                    onUpdateBackgroundImage={updateSlideBackgroundImage}
                    onDeleteSlide={deleteSlide}
                    onDuplicateSlide={duplicateSlide}
                    slideCount={deck.slideOrder.length}
                />
            )}
        </div>
    );
}

type ApplyTo = 'this' | 'this-and-following' | 'all';

function SlideBackgroundPanel({deck, activeSlideId, currentBackground, currentBackgroundImage, currentBackgroundImageSourcePath, onUpdateBackground, onUpdateBackgroundImage, onUploadImage}: {
    deck: DeckData;
    activeSlideId: string;
    currentBackground: string;
    currentBackgroundImage: string;
    currentBackgroundImageSourcePath?: DrivePath;
    onUpdateBackground: (color: string, applyTo: ApplyTo) => void;
    onUpdateBackgroundImage: (url: string, sourcePath: DrivePath | undefined, applyTo: ApplyTo) => void;
    onUploadImage: (file: File) => Promise<{src: string; sourcePath: DrivePath} | null>;
}) {
    const [colorOpen, setColorOpen] = useState(false);
    const [applyTo, setApplyTo] = useState<ApplyTo>('this');
    const bgImageInputRef = useRef<HTMLInputElement>(null);

    const handleImageSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const result = await onUploadImage(file);
        if (result) onUpdateBackgroundImage(result.src, result.sourcePath, applyTo);
        e.target.value = '';
    }, [onUploadImage, onUpdateBackgroundImage, applyTo]);

    const handleApply = useCallback(() => {
        onUpdateBackground(currentBackground, applyTo);
        if (currentBackgroundImage) {
            onUpdateBackgroundImage(currentBackgroundImage, currentBackgroundImageSourcePath, applyTo);
        } else {
            onUpdateBackgroundImage('', undefined, applyTo);
        }
    }, [applyTo, currentBackground, currentBackgroundImage, currentBackgroundImageSourcePath, onUpdateBackground, onUpdateBackgroundImage]);

    return (
        <div className="w-64 border-l bg-background shrink-0 h-full flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b">
                <span className="text-sm font-medium">Slide</span>
            </div>

            <div className="border-b px-3 py-3 space-y-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Background color</h4>
                <Popover open={colorOpen} onOpenChange={setColorOpen}>
                    <PopoverTrigger asChild>
                        <button className="flex items-center gap-2 h-8 px-2 rounded hover:bg-accent text-sm w-full">
                            <div
                                className="h-5 w-5 rounded border border-border shrink-0"
                                style={{backgroundColor: currentBackground}}
                            />
                            <span className="text-xs flex-1 text-left">Color</span>
                            <span className="text-xs text-muted-foreground">{currentBackground}</span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent side="left" align="start" className="w-auto">
                        <ColorPicker
                            value={currentBackground}
                            onChange={(c) => { onUpdateBackground(c || '#ffffff', 'this'); setColorOpen(false); }}
                            showReset={false}
                        />
                    </PopoverContent>
                </Popover>
            </div>

            <div className="border-b px-3 py-3 space-y-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Background image</h4>
                {currentBackgroundImage ? (
                    <div className="space-y-2">
                        <div className="rounded border overflow-hidden">
                            <img src={currentBackgroundImage} alt="" className="w-full h-20 object-cover"/>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            onClick={() => onUpdateBackgroundImage('', undefined, 'this')}
                        >
                            <Trash2 className="h-3.5 w-3.5 mr-1.5"/>
                            Remove image
                        </Button>
                    </div>
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => bgImageInputRef.current?.click()}
                    >
                        <ImageIcon className="h-3.5 w-3.5 mr-1.5"/>
                        Upload image
                    </Button>
                )}
                <input
                    ref={bgImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageSelect}
                />
            </div>

            <div className="px-3 py-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Apply to</h4>
                <div className="flex gap-2">
                    <Select value={applyTo} onValueChange={(v) => setApplyTo(v as ApplyTo)}>
                        <SelectTrigger className="h-8 text-xs flex-1">
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="this">This slide</SelectItem>
                            <SelectItem value="this-and-following">This and following</SelectItem>
                            <SelectItem value="all">All slides</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 text-xs" onClick={handleApply}>
                        Apply
                    </Button>
                </div>
            </div>
        </div>
    );
}
