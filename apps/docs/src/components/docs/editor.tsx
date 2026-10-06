import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { Node } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { useAuth } from '@workspace/lib/auth';
import type { ClipboardBox } from '@workspace/lib/clipboard';
import {
    buildImageClipboardItem,
    classifyPaste,
    clipboardTextItemHasContent,
    hasRichHtmlBeyondMarker,
    materializeClipboardSvg,
    needsReUpload,
    readClipboardBox,
    reUploadImage,
    writeEigenClipboard,
} from '@workspace/lib/clipboard';
import { useCollabDoc } from '@workspace/lib/collab';
import {
    findCardIdByChatName,
    useCommentFilter,
    useCommentLifecycle,
    useDocumentPanels,
} from '@workspace/lib/comments';
import { userColor } from '@workspace/lib/constants/colors';
import { getFontFamily, getFontName } from '@workspace/lib/constants/fonts';
import { DEFAULT_PAGE_SETUP, getDocExtensions, pagePx, pageStylesheet } from '@workspace/lib/docs/eigendoc';
import {
    isPendingMediaName,
    MediaResolverProvider,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { htmlToPlainText } from '@workspace/lib/html-dom';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type {
    EigenClipboardData,
    EigenClipboardImageItem,
    EigenClipboardItem,
    EigenClipboardTextItem,
} from '@workspace/lib/types/clipboard';
import type { CardAttachmentDraft, CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_IMAGE_BOX } from '@workspace/lib/vector';
import { CollabDocumentGate, Column, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import { renderPresenceCaret } from '@workspace/ui/components/collab';
import {
    type CommentContextMenuItem,
    CommentLifecycleDialogs,
    CommentLifecycleMenuItems,
    CommentMenuItems,
    PanelColumn,
} from '@workspace/ui/components/comments';
import { ContextMenuAnchor, DownloadImageMenuItem, useContextMenu } from '@workspace/ui/components/context-menu';
import { DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { PROPERTIES_PANEL_WIDTH_PX } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/search/prosemirror-search-highlight';
import { useElementSize } from '@workspace/ui/hooks/use-element-size';
import { cn } from '@workspace/ui/lib/utils';
import { common, createLowlight } from 'lowlight';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { EditorToolbar } from './editor-toolbar';
import { CommentMark, commentAnchorText, nodeCommentCardId, updateCommentDecorations } from './extensions/comment-mark';
import { Figure } from './extensions/figure';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { useActiveComments } from './hooks/use-active-comments';
import { TablePropertiesPanel } from './table-properties-panel';

function findCommentAnchors(doc: Node, cardId: string): { node: Node; pos: number; end: number }[] {
    const anchors: { node: Node; pos: number; end: number }[] = [];
    doc.descendants((node, pos) => {
        if (nodeCommentCardId(node) === cardId) anchors.push({ node, pos, end: pos + node.nodeSize });
    });
    return anchors;
}

function swapFigureMediaName(editor: Editor, pendingName: string, newName: string | null) {
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure' && node.attrs.mediaName === pendingName) {
            positions.push(pos);
        }
        return true;
    });
    if (positions.length === 0) return;
    editor.commands.command(({ tr, dispatch }) => {
        // Iterate in reverse so earlier positions stay valid after later deletes
        for (let i = positions.length - 1; i >= 0; i--) {
            const pos = positions[i];
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            if (newName === null) {
                tr.delete(pos, pos + node.nodeSize);
            } else {
                tr.setNodeAttribute(pos, 'mediaName', newName);
            }
        }
        if (dispatch) dispatch(tr);
        return true;
    });
}

// The clipboard box for a figure at `pos`. Figures store WIDTH ONLY on purpose (the doc reflows and
// the height must follow the image), but the wire carries both dims, so measure the rendered <img>.
// clientWidth, not getBoundingClientRect: layout px are the space the stored width lives in (the
// identity mapping in extensions/figure.tsx), while a narrow viewport puts a `scale()` on the page.
// Height comes from the image's own intrinsic ratio rather than its laid-out height, so a mid-load
// layout can't skew it. Nothing measurable (node view not mounted, image not loaded) → the stored
// width at the shared default ratio, the single fallback.
function figureClipboardBox(editor: Editor, pos: number, storedWidth: unknown): ClipboardBox {
    const dom = editor.view.nodeDOM(pos);
    const img = dom instanceof HTMLElement ? dom.querySelector('img') : null;
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
        const ratio =
            img.naturalWidth > 0 && img.naturalHeight > 0
                ? img.naturalWidth / img.naturalHeight
                : img.clientWidth / img.clientHeight;
        return { width: img.clientWidth, height: img.clientWidth / ratio };
    }
    const width = typeof storedWidth === 'number' && storedWidth > 0 ? storedWidth : DEFAULT_IMAGE_BOX.width;
    return { width, height: (width * DEFAULT_IMAGE_BOX.height) / DEFAULT_IMAGE_BOX.width };
}

// The textStyle `fontFamily` attr is an EIGEN_FONTS name, but a stored doc may hold a full CSS stack and
// y-prosemirror hydrates without parseHTML, so this pass collapses a known stack to its name on editable
// load. renderHTML maps the name back to the same stack. Kept out of the undo history.
function normalizeFontFamilyMarks(editor: Editor) {
    const markType = editor.schema.marks.textStyle;
    if (!markType) return;
    const targets: { from: number; to: number; attrs: Record<string, unknown> }[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type === markType);
        if (!mark) return;
        const family = mark.attrs.fontFamily;
        if (typeof family !== 'string' || !family) return;
        const canon = getFontName(family);
        if (canon === family) return;
        targets.push({ from: pos, to: pos + node.nodeSize, attrs: { ...mark.attrs, fontFamily: canon } });
    });
    if (targets.length === 0) return;
    editor.commands.command(({ tr, dispatch }) => {
        for (const { from, to, attrs } of targets) {
            tr.addMark(from, to, markType.create(attrs));
        }
        tr.setMeta('addToHistory', false);
        if (dispatch) dispatch(tr);
        return true;
    });
}

const lowlight = createLowlight(common);

// Block-level text-align values docs models; an unrecognized wire value drops rather than storing garbage.
const TEXT_ALIGNS = new Set(['left', 'center', 'right', 'justify']);

// The page at 96 dpi, for the layout math below and the text column before the page mounts.
const PAGE_PX = pagePx(DEFAULT_PAGE_SETUP);
const TEXT_COLUMN_WIDTH_PX = PAGE_PX.width - PAGE_PX.margin.left - PAGE_PX.margin.right;
const PAGE_STYLESHEET = pageStylesheet(DEFAULT_PAGE_SETUP, '[data-document]');

// The panel is an absolute overlay, so it covers all of the scroll box's content box but its p-4 gutter.
const PANEL_INTRUSION_PX = PROPERTIES_PANEL_WIDTH_PX - 16;
// Only the text column has to stay clear of the panel; the page's right margin may tuck under it.
const TEXT_COLUMN_RIGHT_PX = PAGE_PX.width - PAGE_PX.margin.right;
// Above this the panel clears the centered page outright: every value below is pinned, so stop storing width.
const PANEL_CLEAR_WIDTH_PX = 2 * (TEXT_COLUMN_RIGHT_PX + PANEL_INTRUSION_PX) - PAGE_PX.width;

export const CollaborativeEditor = ({
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: {
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    // No UndoManager: y-prosemirror's history plugin owns undo.
    const {
        doc: yDoc,
        provider,
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
    } = useCollabDoc({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
    });

    return (
        <CollabDocumentGate collab={{ loaded, storageUnavailable, storageGone }} path={path} canWrite={canWrite}>
            {provider && yDoc && (
                <MediaResolverProvider
                    ownerId={path.ownerId}
                    mountId={path.mountId}
                    mediaFolderId={mediaFolderId}
                    chatFolderId={chatFolderId}
                >
                    <UnsyncedEditsGuard active={unsyncedEdits} />
                    <TiptapEditor
                        key={path.id}
                        path={path}
                        yDoc={yDoc}
                        provider={provider}
                        canWrite={canWrite}
                        offline={offline}
                        storageUnavailable={storageUnavailable}
                        mediaFolderId={mediaFolderId}
                        chatFolderId={chatFolderId}
                        onAccessDialogOpen={onAccessDialogOpen}
                        initialChatName={initialChatName}
                        initialSearchTerm={initialSearchTerm}
                    />
                </MediaResolverProvider>
            )}
        </CollabDocumentGate>
    );
};

const TiptapEditor = ({
    yDoc,
    provider,
    path,
    canWrite,
    offline,
    storageUnavailable,
    mediaFolderId,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    initialSearchTerm,
}: {
    yDoc: Y.Doc;
    provider: WebsocketProvider;
    path: DrivePath;
    canWrite: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    const auth = useAuth();
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(path.ownerId, path.mountId);
    const { resolveMediaPath, startUpload } = useMediaResolver();
    const [addOpen, setAddOpen] = useState(false);
    const [pendingMarkRange, setPendingMarkRange] = useState<{ from: number; to: number; text: string } | null>(null);
    const { isMobile } = useLayout();
    const {
        panel,
        commentPanelOpen,
        activityPanelOpen,
        mobilePanelOpen,
        toggleComments,
        toggleActivity,
        openComments,
        closePanels,
        onSearchOpenChange,
    } = useDocumentPanels(isMobile);
    const [docHeight, setDocHeight] = useState(0);
    const needsScaleRef = useRef(false);
    const documentRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<ReturnType<typeof useEditor>>(null);
    const handleAddCommentRef = useRef<(() => void) | null>(null);
    const allCommentsRef = useRef<CommentEntry[]>([]);
    const cardsRef = useRef<Record<string, CommentCard>>({});
    // The extensions keep the closures they were created with, so the figure menu reads this render's state here.
    const figureContextMenuRef = useRef<(node: Node, pos: number, event: React.MouseEvent) => void>(() => {});
    const mediaFolderIdRef = useRef(mediaFolderId);
    mediaFolderIdRef.current = mediaFolderId;

    const commentMenuItem = (cardId: string | null): CommentContextMenuItem | null => {
        const card = cardId ? cardsRef.current[cardId] : undefined;
        if (!card) return null;
        const entry = card.chatName ? allCommentsRef.current.find((c) => c.chatName === card.chatName) : undefined;
        return { card, entry };
    };

    const getEditorMaxWidth = useCallback(() => {
        const el = documentRef.current;
        if (!el) return TEXT_COLUMN_WIDTH_PX;
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }, []);

    const [setScrollContainer, scrollSize] = useElementSize(scrollContainerRef);
    // Past PANEL_CLEAR_WIDTH_PX the page and the panel no longer contend, so the layout math stops there.
    const containerWidth = Math.min(scrollSize.width, PANEL_CLEAR_WIDTH_PX);

    // Hand-rolled rather than useElementSize: this measures the BORDER box, and stays quiet while
    // unscaled so a doc that needs no scaling never re-renders on its own growth.
    const setDocumentEl = useCallback((el: HTMLDivElement | null) => {
        documentRef.current = el;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            // Only the scaled branch reads docHeight; the effect below seeds it on the way in.
            if (!needsScaleRef.current) return;
            const height = el.offsetHeight;
            if (height === 0) return;
            setDocHeight(height);
        });
        ro.observe(el);
        return () => {
            documentRef.current = null;
            ro.disconnect();
        };
    }, []);

    // Same split as openCard below: the mobile pane hides the document, so a mark tap only opens the
    // card dialog over it.
    const handleCommentClick = useCallback(
        (cardId: string) => {
            if (!isMobile) openComments();
            setOpenCardId(cardId);
        },
        [isMobile, openComments],
    );

    const editor = useEditor(
        {
            editable: canWrite,
            extensions: [
                ...getDocExtensions({ lowlight, exclude: ['figure', 'comment'] }),
                Figure.configure({
                    onOpenComment: handleCommentClick,
                    onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
                }),
                TableWidthClamp,
                SearchHighlight,
                CommentMark.configure({
                    onCommentClick: handleCommentClick,
                    onCommentContextMenu: (cardId, event) => {
                        const item = commentMenuItem(cardId);
                        if (item) commentContextMenu.openAt(item, event.clientX, event.clientY);
                    },
                    onSelectionContextMenu: (event) => {
                        selectionContextMenu.openAt(true, event.clientX, event.clientY);
                    },
                    onAddComment: () => handleAddCommentRef.current?.(),
                    onToggleCommentPanel: toggleComments,
                }),
                Collaboration.configure({
                    document: yDoc,
                }),
                CollaborationCaret.configure({
                    provider,
                    // userId is what the server's awareness gate checks; without it every frame is dropped
                    user: {
                        name: auth.user!.name,
                        color: userColor(auth.user!.id),
                        userId: auth.user!.id,
                    },
                    render: (user: Record<string, string>) =>
                        renderPresenceCaret({ name: user.name, color: user.color }),
                }),
            ],
            editorProps: {
                attributes: {
                    class: 'eigen-prose',
                },
                transformPastedHTML: (html: string) => {
                    const maxWidth = getEditorMaxWidth();
                    const doc = new DOMParser().parseFromString(html, 'text/html');

                    const fontMap: Record<string, string> = {
                        'Times New Roman': getFontFamily('Source Serif 4'),
                        Georgia: getFontFamily('Source Serif 4'),
                        Palatino: getFontFamily('Source Serif 4'),
                        'Palatino Linotype': getFontFamily('Source Serif 4'),
                        'Courier New': getFontFamily('JetBrains Mono'),
                        Consolas: getFontFamily('JetBrains Mono'),
                        'Comic Sans MS': getFontFamily('Excalifont'),
                    };
                    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
                        const ff = el.style.fontFamily.replace(/['"]/g, '').trim();
                        el.style.fontFamily = fontMap[ff] ?? '';
                    });

                    doc.querySelectorAll<HTMLElement>('img, table').forEach((el) => {
                        const attrWidth = el.getAttribute('width');
                        const styleWidth = el.style.width;
                        let w = 0;
                        if (attrWidth) w = parseInt(attrWidth, 10) || 0;
                        if (!w && styleWidth?.endsWith('px')) w = parseInt(styleWidth, 10) || 0;

                        if (w > maxWidth) {
                            el.setAttribute('width', String(Math.round(maxWidth)));
                            el.style.width = `${Math.round(maxWidth)}px`;
                        }
                    });

                    return doc.body.innerHTML;
                },
                handleDrop: (view, event) => {
                    if (!event.dataTransfer) return false;
                    const files = Array.from(event.dataTransfer.files);
                    const imageFile = files.find((f) => f.type.startsWith('image/'));
                    if (imageFile && mediaFolderIdRef.current) {
                        event.preventDefault();
                        const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
                        if (dropPos) {
                            const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(dropPos.pos)));
                            view.dispatch(tr);
                        }
                        handleImageUpload(imageFile).catch(() => {});
                        return true;
                    }
                    return false;
                },
                handlePaste: (_view, event) => {
                    if (!event.clipboardData) return false;
                    const paste = classifyPaste(event.clipboardData);
                    const mediaFolderId = mediaFolderIdRef.current;

                    // A vector SVG payload (or a pasted SVG document) lands as a figure through the exact
                    // image-upload path — stored in media/, served as-is, rendered by <image>. Its images
                    // are name-referenced (eigen-media:); materialize re-uploads each into our media/ and
                    // rewrites the svg's refs before it's stored.
                    if (paste.svg && mediaFolderId) {
                        event.preventDefault();
                        materializeClipboardSvg(paste.svg.svg, paste.svg.items, mediaFolderId, uploadFile.mutateAsync)
                            .then(handleImageUpload)
                            .catch(() => {});
                        return true;
                    }

                    if (paste.eigen) {
                        // Images take this path for the cross-mount re-upload; text only when text/html
                        // is marker-only (a canvas text copy), so a sheets table still parses in PM. Claimed
                        // only with an item this editor can place, or ⌘V on a bare `elements` item is dead.
                        const hasImage = paste.eigen.items.some((i) => i.type === 'image');
                        const hasText = paste.eigen.items.some(
                            (i) => i.type === 'text' && clipboardTextItemHasContent(i),
                        );
                        if (hasImage || (hasText && !hasRichHtmlBeyondMarker(event.clipboardData))) {
                            event.preventDefault();
                            handleEigenItemsPaste(paste.eigen.items).catch(() => {});
                            return true;
                        }
                    }

                    const imageFile = paste.imageFiles[0];
                    if (imageFile && mediaFolderId) {
                        event.preventDefault();
                        handleImageUpload(imageFile).catch(() => {});
                        return true;
                    }
                    return false;
                },
            },
        },
        [handleCommentClick],
    );

    editorRef.current = editor;

    const { canUndo, canRedo } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            if (!e) return { canUndo: false, canRedo: false };
            const pluginState = yUndoPluginKey.getState(e.state);
            const um = pluginState?.undoManager;
            return {
                canUndo: (um?.undoStack.length ?? 0) > 0,
                canRedo: (um?.redoStack.length ?? 0) > 0,
            };
        },
    });

    const handleImageUpload = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/') || !editorRef.current) return;
        const { pendingName, promise } = startUpload(file);
        editorRef.current.chain().focus().setFigure({ mediaName: pendingName }).run();
        const result = await promise;
        if (editorRef.current) {
            swapFigureMediaName(editorRef.current, pendingName, result?.name ?? null);
        }
    };

    const handleReplaceImage = async (file: File) => {
        if (!mediaFolderIdRef.current || !file.type.startsWith('image/') || !editorRef.current) return;
        const { pendingName, promise } = startUpload(file);
        // Reset width so the new image's aspect ratio is recomputed on load
        editorRef.current.chain().focus().updateAttributes('figure', { mediaName: pendingName, width: null }).run();
        const result = await promise;
        if (!editorRef.current) return;
        swapFigureMediaName(editorRef.current, pendingName, result?.name ?? null);
    };

    const handleImagePickFromDrive = async (paths: DrivePath[]) => {
        if (!mediaFolderIdRef.current || !editorRef.current) return;
        const results = await copyToMediaFolder
            .mutateAsync({ paths, mediaFolderId: mediaFolderIdRef.current })
            .catch(() => null);
        if (!results) return;
        for (const result of results) {
            editorRef.current.chain().focus().setFigure({ mediaName: result.name }).run();
        }
    };

    const handleReplaceImageFromDrive = async (paths: DrivePath[]) => {
        if (!mediaFolderIdRef.current || !editorRef.current || paths.length === 0) return;
        const result = await copyToMediaFolder
            .mutateAsync({ paths: [paths[0]], mediaFolderId: mediaFolderIdRef.current })
            .catch(() => null);
        if (result?.[0]) {
            editorRef.current
                .chain()
                .focus()
                .updateAttributes('figure', { mediaName: result[0].name, width: null })
                .run();
        }
    };

    const handleEigenImagePaste = async (item: EigenClipboardImageItem, width?: number) => {
        const currentMediaFolderId = mediaFolderIdRef.current;
        if (needsReUpload(item.sourceParentId, currentMediaFolderId) && currentMediaFolderId) {
            const result = await reUploadImage(
                item.sourcePathId,
                item.sourceOwnerId,
                item.sourceMountId,
                currentMediaFolderId,
                uploadFile.mutateAsync,
                item.mediaName,
            );
            // Re-upload failed: skip insertion, don't fall through to the source doc's unresolvable mediaName.
            if (!result) return;
            if (editorRef.current) {
                editorRef.current
                    .chain()
                    .focus()
                    .setFigure({ mediaName: result.mediaName, width, caption: item.caption })
                    .run();
            }
            return;
        }
        if (editorRef.current) {
            editorRef.current
                .chain()
                .focus()
                .setFigure({ mediaName: item.mediaName, width, caption: item.caption })
                .run();
        }
    };

    // A text item lands as one paragraph at the caret, with the typography docs models; it has no
    // fontSize, letter-spacing or line-height. htmlToPlainText guards against a non-conforming payload.
    const insertEigenTextItem = (item: EigenClipboardTextItem) => {
        if (!editorRef.current) return;
        const text = htmlToPlainText(item.text);
        if (!text.trim()) return;
        const typo = item.typography;
        const textStyleAttrs: Record<string, string> = {};
        if (typo?.fontFamily) textStyleAttrs.fontFamily = getFontName(typo.fontFamily);
        if (typo?.color) textStyleAttrs.color = typo.color;
        const marks: { type: string; attrs?: Record<string, string> }[] = [];
        if (Object.keys(textStyleAttrs).length > 0) marks.push({ type: 'textStyle', attrs: textStyleAttrs });
        if (typo?.fontWeight === 'bold') marks.push({ type: 'bold' });
        if (typo?.fontStyle === 'italic') marks.push({ type: 'italic' });
        if (typo?.textDecoration === 'underline') marks.push({ type: 'underline' });
        if (typo?.textDecoration === 'line-through') marks.push({ type: 'strike' });
        const paragraph = {
            type: 'paragraph',
            ...(typo?.textAlign && TEXT_ALIGNS.has(typo.textAlign) ? { attrs: { textAlign: typo.textAlign } } : {}),
            content: [{ type: 'text', text, ...(marks.length > 0 ? { marks } : {}) }],
        };
        editorRef.current.chain().focus().insertContent(paragraph).run();
    };

    // Consume every eigen item in wire order so a mixed slides selection keeps its paragraph/figure
    // sequence at the caret. Image inserts await the per-item re-upload seam (skip-on-failure), so the
    // loop stays ordered; text inserts are synchronous.
    const handleEigenItemsPaste = async (items: EigenClipboardItem[]) => {
        for (const item of items) {
            if (item.type === 'text') {
                insertEigenTextItem(item);
            } else if (item.type === 'image') {
                const { width } = readClipboardBox(item);
                await handleEigenImagePaste(item, width);
            }
        }
    };

    useEffect(() => {
        if (!editor) return;
        const handleCopyOrCut = (e: ClipboardEvent) => {
            if (!editor.isFocused) return;
            const { from, to } = editor.state.selection;
            if (from === to) return;

            const items: EigenClipboardData['items'] = [];
            editor.state.doc.nodesBetween(from, to, (node, pos) => {
                if (node.type.name === 'figure' && node.attrs.mediaName) {
                    const mediaPath = resolveMediaPath(node.attrs.mediaName);
                    if (mediaPath) {
                        items.push(
                            buildImageClipboardItem({
                                mediaName: node.attrs.mediaName,
                                source: mediaPath,
                                box: figureClipboardBox(editor, pos, node.attrs.width),
                                caption: node.attrs.caption || undefined,
                            }),
                        );
                    }
                }
            });

            if (items.length > 0) {
                const text = editor.state.doc.textBetween(from, to, '\n').trim();
                // PM's own serialization keeps figures and typography as rich HTML for every other host;
                // the helper puts the eigen marker before it.
                const { dom } = editor.view.serializeForClipboard(editor.state.selection.content());
                e.preventDefault();
                writeEigenClipboard(e, { version: 1, items }, text || undefined, dom.innerHTML);
            }
        };
        document.addEventListener('copy', handleCopyOrCut);
        document.addEventListener('cut', handleCopyOrCut);
        return () => {
            document.removeEventListener('copy', handleCopyOrCut);
            document.removeEventListener('cut', handleCopyOrCut);
        };
    }, [editor, resolveMediaPath]);

    const handleAddComment = () => {
        if (!editor || !chatFolderId) return;
        const { from, to } = editor.state.selection;
        const text = commentAnchorText(editor.state.doc, from, to);
        if (!text.trim()) return;
        setPendingMarkRange({ from, to, text });
        setAddOpen(true);
    };
    handleAddCommentRef.current = chatFolderId ? handleAddComment : null;

    const [sidebarContext, setSidebarContext] = useState<'document' | 'figure' | 'table'>('document');
    const lastPanelRef = useRef<'figure' | 'table'>('figure');
    if (sidebarContext !== 'document') lastPanelRef.current = sidebarContext;

    const activeComments = useActiveComments(editor);
    const lifecycle = useCommentLifecycle({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
    });
    const { allComments, cards, createCard, assignComment, members, assignedCount, setOpenCardId } = lifecycle;
    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    allCommentsRef.current = allComments;
    cardsRef.current = cards;

    const commentContextMenu = useContextMenu<CommentContextMenuItem>();
    const selectionContextMenu = useContextMenu<boolean>();
    const figureContextMenu = useContextMenu<{
        imagePath: DrivePath | undefined;
        comment: CommentContextMenuItem | null;
    }>();
    const canAddComment = canWrite && !!chatFolderId;
    // Opens only when a row will render; otherwise the browser's own menu shows.
    figureContextMenuRef.current = (node, pos, event) => {
        const imagePath = resolveMediaPath(node.attrs.mediaName ?? '');
        const comment = commentMenuItem(nodeCommentCardId(node));
        if (!imagePath && !comment && !canAddComment) return;
        // Selected first, so Add comment anchors to it.
        editor?.commands.setNodeSelection(pos);
        figureContextMenu.handleContextMenu(event, { imagePath, comment });
    };

    const removeCommentMarks = (cardId: string) => {
        if (!editor) return;
        const { tr } = editor.state;
        const commentType = editor.state.schema.marks.comment;
        for (const { node, pos, end } of findCommentAnchors(editor.state.doc, cardId)) {
            if (node.type.name === 'figure') tr.setNodeAttribute(pos, 'commentCardId', null);
            else tr.removeMark(pos, end, commentType);
        }
        editor.view.dispatch(tr);
    };

    const handleSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            if (!editor || !pendingMarkRange) return;
            const range = pendingMarkRange;
            const card = await createCard({ title: pendingMarkRange.text, ...patch, attachments }, (card) => {
                const node = editor.state.doc.nodeAt(range.from);
                if (node?.type.name === 'figure' && range.to === range.from + node.nodeSize) {
                    editor.view.dispatch(editor.state.tr.setNodeAttribute(range.from, 'commentCardId', card.id));
                    return;
                }
                editor
                    .chain()
                    .focus()
                    .setTextSelection({ from: range.from, to: range.to })
                    .setComment(card.id)
                    // A figure the selection spans would keep the mark only until reload; it anchors by attribute.
                    .command(({ tr }) => {
                        tr.doc.nodesBetween(range.from, range.to, (n, pos) => {
                            if (n.type.name === 'figure')
                                tr.removeMark(pos, pos + n.nodeSize, n.type.schema.marks.comment);
                        });
                        return true;
                    })
                    .run();
            });
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setPendingMarkRange(null);
            setAddOpen(false);
        },
        [editor, pendingMarkRange, createCard, assignComment],
    );

    // Sync resolved IDs + colors into the ProseMirror decoration plugin
    useEffect(() => {
        if (!editor) return;
        const resolved = new Set<string>();
        const colorMap = new Map<string, string>();
        for (const cardId of activeComments.ids) {
            const card = cards[cardId];
            if (!card) continue;
            if (card.color) colorMap.set(cardId, card.color);
            if (card.chatName) {
                const entry = allComments.find((c) => c.chatName === card.chatName);
                if (entry?.status === 'resolved') resolved.add(cardId);
            }
        }
        updateCommentDecorations(editor, resolved, colorMap);
    }, [editor, cards, allComments, activeComments.ids]);

    useEffect(() => {
        if (!editor) return;
        const onUpdate = () => {
            if (editor.isActive('figure')) setSidebarContext('figure');
            else if (editor.isActive('table')) setSidebarContext('table');
            else setSidebarContext('document');
        };
        editor.on('selectionUpdate', onUpdate);
        return () => {
            editor.off('selectionUpdate', onUpdate);
        };
    }, [editor]);

    // Sweep zombie placeholders left behind by a tab close or reload mid-upload. Snapshot the pending
    // figure mediaNames; a completed upload has swapped the name, so the stale name no longer matches.
    useZombieMediaSweep({
        ready: !!editor,
        scan: () => {
            const names: string[] = [];
            editor?.state.doc.descendants((node) => {
                if (
                    node.type.name === 'figure' &&
                    typeof node.attrs.mediaName === 'string' &&
                    isPendingMediaName(node.attrs.mediaName)
                ) {
                    names.push(node.attrs.mediaName);
                }
                return true;
            });
            return names;
        },
        remove: (names) => {
            if (!editor) return;
            for (const name of names) swapFigureMediaName(editor, name, null);
        },
    });

    // One-shot: collapse any legacy full-stack fontFamily marks to their EIGEN_FONTS name once the
    // synced doc is open for editing. The parent gates this subtree on first sync, so the content is
    // present at mount; idempotent, so a canWrite flip re-running it is a no-op.
    useEffect(() => {
        if (!editor || !canWrite) return;
        normalizeFontFamilyMarks(editor);
    }, [editor, canWrite]);

    const docSearchController = useProseMirrorSearchController(editor, canWrite);
    const commentSearchHalf = useDocCommentSearchHalf(path.ownerId, path.mountId, path.id);

    const showSidebar = !isMobile && (panel !== null || (canWrite && sidebarContext !== 'document'));

    // Slide the centered page left by its overlap with the panel; only shrink once the slack runs out.
    const centredSlack = Math.max(0, (containerWidth - PAGE_PX.width) / 2);
    const panelLeft = containerWidth - PANEL_INTRUSION_PX;
    const panelOverlap = showSidebar ? Math.max(0, centredSlack + TEXT_COLUMN_RIGHT_PX - panelLeft) : 0;
    const canShift = containerWidth > 0 && panelOverlap <= centredSlack;
    const canvasShift = canShift ? panelOverlap : 0;
    const canvasScale =
        containerWidth === 0
            ? 1
            : Math.min(1, containerWidth / PAGE_PX.width, canShift ? 1 : panelLeft / TEXT_COLUMN_RIGHT_PX);
    const needsScale = canvasScale < 1;

    // The document observer stays quiet while unscaled, so seed the height on the way in.
    useLayoutEffect(() => {
        needsScaleRef.current = needsScale;
        if (needsScale && documentRef.current) setDocHeight(documentRef.current.offsetHeight);
    }, [needsScale]);

    if (!editor) return null;

    const handleScrollToComment = (cardId: string) => {
        const anchors = findCommentAnchors(editor.state.doc, cardId);
        if (anchors.length === 0) return;
        const { node, pos } = anchors[0];
        const chain = editor.chain().focus();
        const selected = node.type.name === 'figure' ? chain.setNodeSelection(pos) : chain.setTextSelection(pos);
        selected.scrollIntoView().run();
    };

    // Desktop reveals the anchor and switches an activity tap over to comments; the mobile pane hides
    // the editor, so it just opens the card.
    const openCard = (cardId: string) => {
        if (!isMobile) {
            openComments();
            handleScrollToComment(cardId);
        }
        setOpenCardId(cardId);
    };

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
        onOpenCard: openCard,
    };

    // Plain object per render; usePaletteDocSearch stabilises it, so reveal sees the current cards.
    const commentSearch: DocCommentSearch = {
        ...commentSearchHalf,
        reveal: (chatName) => {
            const cardId = findCardIdByChatName(cardsRef.current, chatName);
            if (!cardId) return;
            openComments();
            // The mobile pane hides the editor, so scrolling would drive a view nobody can see.
            if (!isMobile) handleScrollToComment(cardId);
            setOpenCardId(cardId);
        },
    };

    return (
        <>
            <div className="flex h-full w-full overflow-hidden">
                {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
                <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                    <DocSearchProvider
                        controller={docSearchController}
                        commentSearch={commentSearch}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={onSearchOpenChange}
                        // right-68 = panel width + the bar's own gutter.
                        barClassName={cn('top-14', showSidebar && 'right-68')}
                        // No .focus(): focus stays in the bar so the user can keep replacing after ⌘Z.
                        onUndo={() => editor.commands.undo()}
                        onRedo={() => editor.commands.redo()}
                    >
                        <Column
                            id={'doc-editor'}
                            width={'w-full'}
                            toolbarBorder="always"
                            toolbar={
                                <EditorToolbar
                                    editor={editor}
                                    path={path}
                                    canWrite={canWrite}
                                    offline={offline}
                                    storageUnavailable={storageUnavailable}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    // Always offered: desktop draws the side panel, mobile the Column.
                                    onToggleCommentPanel={toggleComments}
                                    commentPanelOpen={commentPanelOpen}
                                    onToggleActivityPanel={toggleActivity}
                                    activityPanelOpen={activityPanelOpen}
                                    assignedCommentCount={assignedCount}
                                    onImageUpload={mediaFolderId ? handleImageUpload : undefined}
                                    onImagePickFromDrive={mediaFolderId ? handleImagePickFromDrive : undefined}
                                    onAddComment={chatFolderId ? handleAddComment : undefined}
                                />
                            }
                        >
                            <div className="h-full relative overflow-hidden">
                                {/* The page box, and on paper the @page margins in its place; the printed clone matches it too. */}
                                <style>{PAGE_STYLESHEET}</style>
                                <div
                                    ref={setScrollContainer}
                                    className={cn(
                                        'h-full w-full overflow-y-scroll bg-muted p-4',
                                        needsScale && 'overflow-x-hidden',
                                    )}
                                    onClick={(e) => {
                                        if (e.target === scrollContainerRef.current) {
                                            editor.commands.blur();
                                        }
                                    }}
                                >
                                    <div
                                        data-document="true"
                                        className={cn(
                                            // eigen-paper: the page always renders light, in dark mode too (globals.css)
                                            'eigen-paper grid bg-white rounded-lg shadow-sm shadow-transparent print:shadow-none',
                                            !needsScale && 'min-h-full m-auto',
                                        )}
                                        ref={setDocumentEl}
                                        style={
                                            needsScale
                                                ? {
                                                      transform: `scale(${canvasScale})`,
                                                      transformOrigin: 'top left',
                                                      marginBottom: -(1 - canvasScale) * docHeight,
                                                  }
                                                : canvasShift > 0
                                                  ? { transform: `translateX(${-canvasShift}px)` }
                                                  : undefined
                                        }
                                    >
                                        <EditorContent editor={editor} className="h-full min-w-0 tiptap-wrapper" />
                                    </div>
                                </div>
                                {/* Unmounted when closed: the properties panels key-remount per caret move.
                                    The stable gutter is as wide as the scroll box's scrollbar and draws
                                    none, so the panel ends left of that scrollbar, where the shift math
                                    already puts its edge. */}
                                {showSidebar && (
                                    <div className="pointer-events-none absolute inset-0 overflow-hidden [scrollbar-gutter:stable]">
                                        <div className="pointer-events-auto absolute inset-y-0 right-0">
                                            {panel ? (
                                                <PanelColumn activePanel={panel} {...panelProps} />
                                            ) : lastPanelRef.current === 'figure' ? (
                                                <FigurePropertiesPanel
                                                    key={editor.state.selection.from}
                                                    editor={editor}
                                                    onReplaceImage={handleReplaceImage}
                                                    onReplaceImageFromDrive={handleReplaceImageFromDrive}
                                                />
                                            ) : (
                                                <TablePropertiesPanel editor={editor} />
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </Column>
                    </DocSearchProvider>
                </div>

                {mobilePanelOpen && panel && <PanelColumn activePanel={panel} {...panelProps} />}
            </div>

            <CardFormDialog
                open={addOpen}
                onOpenChange={(o) => {
                    setAddOpen(o);
                    if (!o) setPendingMarkRange(null);
                }}
                initialTitle={pendingMarkRange?.text ?? ''}
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
                onDelete={removeCommentMarks}
            />

            <ContextMenuAnchor contextMenu={figureContextMenu}>
                <DownloadImageMenuItem path={figureContextMenu.item?.imagePath} />
                {figureContextMenu.item?.imagePath && (figureContextMenu.item.comment || canAddComment) && (
                    <DropdownMenuSeparator />
                )}
                <CommentLifecycleMenuItems
                    lifecycle={lifecycle}
                    item={figureContextMenu.item?.comment ?? null}
                    canWrite={canWrite}
                    onAddComment={chatFolderId ? handleAddComment : undefined}
                    onDelete={removeCommentMarks}
                />
            </ContextMenuAnchor>

            <ContextMenuAnchor contextMenu={selectionContextMenu}>
                <CommentMenuItems
                    item={null}
                    onAddComment={() => {
                        handleAddCommentRef.current?.();
                        selectionContextMenu.close();
                    }}
                />
            </ContextMenuAnchor>
        </>
    );
};
