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
    hasRichHtmlBeyondMarker,
    materializeClipboardSvg,
    needsReUpload,
    readClipboardBox,
    readEigenClipboard,
    readSvgClipboardWithItems,
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
import { A4_WIDTH_PX, getDocExtensions, PAGE_MARGIN_PX } from '@workspace/lib/docs/eigendoc';
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
import type { CardAttachmentDraft, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DEFAULT_IMAGE_BOX } from '@workspace/lib/vector';
import { Column, LoadingState, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import { renderPresenceCaret } from '@workspace/ui/components/collab';
import {
    type CommentContextMenuItem,
    CommentLifecycleDialogs,
    CommentMenuItems,
    PanelColumn,
} from '@workspace/ui/components/comments';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { PROPERTIES_PANEL_WIDTH_PX } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/search/prosemirror-search-highlight';
import { cn } from '@workspace/ui/lib/utils';
import { common, createLowlight } from 'lowlight';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { EditorToolbar } from './editor-toolbar';
import { CommentMark, updateCommentDecorations } from './extensions/comment-mark';
import { Figure } from './extensions/figure';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { useActiveComments } from './hooks/use-active-comments';
import { TablePropertiesPanel } from './table-properties-panel';

function findCommentMarkPositions(doc: Node, cardId: string): { pos: number; end: number }[] {
    const positions: { pos: number; end: number }[] = [];
    doc.descendants((node, pos) => {
        for (const mark of node.marks) {
            if (mark.type.name === 'comment' && mark.attrs.cardId === cardId) {
                positions.push({ pos, end: pos + node.nodeSize });
            }
        }
    });
    return positions;
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

// Docs historically stored the textStyle `fontFamily` attr as a full CSS stack; the canon is now
// the EIGEN_FONTS name (matching slides/vector). New writes store the name, but stored collab docs
// hydrate through y-prosemirror without ever running parseHTML, so this one-shot pass collapses any
// recognized stack to its name on editable load — killing the dual representation. renderHTML maps
// the name back to the same stack, so rendered output is unchanged. Kept out of the undo history.
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

// The panel is an absolute overlay, so it covers all of the scroll box's content box but its p-4 gutter.
const PANEL_INTRUSION_PX = PROPERTIES_PANEL_WIDTH_PX - 16;
// Only the text column has to stay clear of the panel; the page's right margin may tuck under it.
const TEXT_COLUMN_RIGHT_PX = A4_WIDTH_PX - PAGE_MARGIN_PX;
// Above this the panel clears the centred page outright: every value below is pinned, so stop storing width.
const PANEL_CLEAR_WIDTH_PX = 2 * (TEXT_COLUMN_RIGHT_PX + PANEL_INTRUSION_PX) - A4_WIDTH_PX;

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
    // Shared collab lifecycle. This also fixes the long-standing leak where docs created its Y.Doc
    // via useMemo and never destroyed it (only the provider was torn down); the hook destroys the
    // doc on unmount / pathId switch. No UndoManager — y-prosemirror's history plugin owns undo.
    const {
        doc: yDoc,
        provider,
        loaded,
    } = useCollabDoc({
        ownerId: path.ownerId,
        mountId: path.mountId,
        pathId: path.id,
    });

    // Gate on the LATCHED loaded flag, not live `synced`: a mid-session WS blip must not unmount
    // TiptapEditor (y-prosemirror's undo history is destroyed on unmount); the mounted editor
    // converges on reconnect.
    if (!loaded || !provider || !yDoc) {
        return <LoadingState />;
    }

    return (
        <MediaResolverProvider
            ownerId={path.ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <TiptapEditor
                key={path.id}
                path={path}
                yDoc={yDoc}
                provider={provider}
                canWrite={canWrite}
                mediaFolderId={mediaFolderId}
                chatFolderId={chatFolderId}
                onAccessDialogOpen={onAccessDialogOpen}
                initialChatName={initialChatName}
                initialSearchTerm={initialSearchTerm}
            />
        </MediaResolverProvider>
    );
};

const TiptapEditor = ({
    yDoc,
    provider,
    path,
    canWrite,
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
    const [containerWidth, setContainerWidth] = useState(0);
    const [docHeight, setDocHeight] = useState(0);
    const needsScaleRef = useRef(false);
    const documentRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<ReturnType<typeof useEditor>>(null);
    const handleAddCommentRef = useRef<(() => void) | null>(null);
    const allCommentsRef = useRef<CommentEntry[]>([]);
    const cardsRef = useRef<Record<string, CommentCard>>({});
    const mediaFolderIdRef = useRef(mediaFolderId);
    mediaFolderIdRef.current = mediaFolderId;

    const getEditorMaxWidth = useCallback(() => {
        const el = documentRef.current;
        if (!el) return 642;
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    }, []);

    // Callback refs so each observer dies with its node; the 0×0 guard keeps the last good width when a
    // hidden surface (the mobile pane) measures zero, so the page doesn't flip layout on the way back.
    const setScrollContainer = useCallback((el: HTMLDivElement | null) => {
        scrollContainerRef.current = el;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === 0) return;
            setContainerWidth(Math.min(entry.contentRect.width, PANEL_CLEAR_WIDTH_PX));
        });
        ro.observe(el);
        return () => {
            scrollContainerRef.current = null;
            ro.disconnect();
        };
    }, []);

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
                Figure,
                TableWidthClamp,
                SearchHighlight,
                CommentMark.configure({
                    onCommentClick: handleCommentClick,
                    onCommentContextMenu: (cardId, event) => {
                        const card = cardsRef.current[cardId];
                        if (!card) return;
                        const entry = card.chatName
                            ? allCommentsRef.current.find((c) => c.chatName === card.chatName)
                            : undefined;
                        commentContextMenu.openAt({ card, entry }, event.clientX, event.clientY);
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
                    user: {
                        name: auth.user!.name,
                        color: userColor(auth.user!.id),
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
                    doc.querySelectorAll('[style]').forEach((el) => {
                        const htmlEl = el as HTMLElement;
                        const ff = htmlEl.style.fontFamily.replace(/['"]/g, '').trim();
                        const mapped = fontMap[ff];
                        if (mapped) {
                            htmlEl.style.fontFamily = mapped;
                        } else {
                            htmlEl.style.fontFamily = '';
                        }
                    });

                    doc.querySelectorAll('img, table').forEach((el) => {
                        const htmlEl = el as HTMLElement;

                        const attrWidth = el.getAttribute('width');
                        const styleWidth = htmlEl.style.width;
                        let w = 0;
                        if (attrWidth) w = parseInt(attrWidth, 10) || 0;
                        if (!w && styleWidth?.endsWith('px')) w = parseInt(styleWidth, 10) || 0;

                        if (w > maxWidth) {
                            el.setAttribute('width', String(Math.round(maxWidth)));
                            htmlEl.style.width = `${Math.round(maxWidth)}px`;
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

                    // A vector SVG payload (or a pasted SVG document) lands as a figure through the
                    // exact image-upload path — stored in media/, served as-is, rendered by <image>.
                    // Its images are name-referenced (eigen-media:); materialize re-uploads each into our
                    // media/ and rewrites the svg's refs before it's stored.
                    const svgPayload = readSvgClipboardWithItems(event.clipboardData);
                    const svgMediaFolderId = mediaFolderIdRef.current;
                    if (svgPayload && svgMediaFolderId) {
                        event.preventDefault();
                        materializeClipboardSvg(
                            svgPayload.svg,
                            svgPayload.items,
                            svgMediaFolderId,
                            uploadFile.mutateAsync,
                        )
                            .then(handleImageUpload)
                            .catch(() => {});
                        return true;
                    }

                    const eigenData = readEigenClipboard(event.clipboardData);
                    if (eigenData && eigenData.items.length > 0) {
                        // Image payloads MUST take the eigen path (the cross-mount re-upload seam).
                        // A text-only payload is consumed directly only when text/html is marker-only
                        // (slides — PM fallthrough there pastes nothing); a rich-HTML producer (sheets
                        // tables) is left to PM so its <table> parses as a real docs table.
                        const hasImage = eigenData.items.some((i) => i.type === 'image');
                        if (hasImage || !hasRichHtmlBeyondMarker(event.clipboardData)) {
                            event.preventDefault();
                            handleEigenItemsPaste(eigenData.items).catch(() => {});
                            return true;
                        }
                    }

                    const files = Array.from(event.clipboardData.files);
                    const imageFile = files.find((f) => f.type.startsWith('image/'));
                    if (imageFile && mediaFolderIdRef.current) {
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

    // A text item (from slides/vector) lands as a single paragraph at the caret. Docs models
    // fontFamily (name, per the fontFamily value canon — getFontName tolerates a name or a legacy
    // stack) and color as textStyle attrs, and textAlign as a block attr; fontSize and the rest of the
    // slides typography superset drop gracefully (docs has no fontSize control by design). `text` is
    // plain on the wire (slides keeps its rich HTML in private meta); htmlToPlainText guards against a
    // non-conforming payload — item-level typography is the best-effort fidelity the wire block carries.
    const insertEigenTextItem = (item: EigenClipboardTextItem) => {
        if (!editorRef.current) return;
        const text = htmlToPlainText(item.text);
        // Empty carriers (vector shapes ride as empty text items) must not land as blank paragraphs.
        if (!text.trim()) return;
        const typo = item.typography;
        const textStyleAttrs: Record<string, string> = {};
        if (typo?.fontFamily) textStyleAttrs.fontFamily = getFontName(typo.fontFamily);
        if (typo?.color) textStyleAttrs.color = typo.color;
        const marks =
            Object.keys(textStyleAttrs).length > 0 ? [{ type: 'textStyle', attrs: textStyleAttrs }] : undefined;
        const paragraph = {
            type: 'paragraph',
            ...(typo?.textAlign && TEXT_ALIGNS.has(typo.textAlign) ? { attrs: { textAlign: typo.textAlign } } : {}),
            content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
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
            } else {
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
                // PM's own clipboard serialization emits the selection as rich HTML — figures via the
                // FigureNode renderHTML (<figure><img data-media-name…>), text with its typography marks
                // — so docs→slides/sheets keeps typography and docs→anywhere keeps readable content. The
                // helper prepends the eigen marker span (marker first). Pure-text selections never reach
                // here (items.length === 0): PM's native copy already carries full rich HTML.
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
        const text = editor.state.doc.textBetween(from, to, ' ');
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

    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            if (!editor || !pendingMarkRange) return;
            const range = pendingMarkRange;
            const card = await createCard(
                { title: pendingMarkRange.text.slice(0, 100), ...patch, attachments },
                (card) => {
                    editor
                        .chain()
                        .focus()
                        .setTextSelection({ from: range.from, to: range.to })
                        .setComment(card.id)
                        .run();
                },
            );
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

    // Slide the centred page left by its overlap with the panel; only shrink once the slack runs out.
    const centredSlack = Math.max(0, (containerWidth - A4_WIDTH_PX) / 2);
    const panelLeft = containerWidth - PANEL_INTRUSION_PX;
    const panelOverlap = showSidebar ? Math.max(0, centredSlack + TEXT_COLUMN_RIGHT_PX - panelLeft) : 0;
    const canShift = containerWidth > 0 && panelOverlap <= centredSlack;
    const canvasShift = canShift ? panelOverlap : 0;
    const canvasScale =
        containerWidth === 0
            ? 1
            : Math.min(1, containerWidth / A4_WIDTH_PX, canShift ? 1 : panelLeft / TEXT_COLUMN_RIGHT_PX);
    const needsScale = canvasScale < 1;

    // The document observer stays quiet while unscaled, so seed the height on the way in.
    useLayoutEffect(() => {
        needsScaleRef.current = needsScale;
        if (needsScale && documentRef.current) setDocHeight(documentRef.current.offsetHeight);
    }, [needsScale]);

    if (!editor) return null;

    const handleScrollToComment = (cardId: string) => {
        const positions = findCommentMarkPositions(editor.state.doc, cardId);
        if (positions.length > 0) {
            editor.chain().focus().setTextSelection(positions[0].pos).scrollIntoView().run();
        }
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
                                            'eigen-paper grid p-[2cm] bg-white rounded-lg shadow-sm shadow-transparent w-[210mm] print:shadow-none',
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
                                {/* Unmounted when closed: the properties panels key-remount per caret move. */}
                                {showSidebar && (
                                    <div className="absolute inset-y-0 right-0">
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
                initialTitle={pendingMarkRange ? pendingMarkRange.text.slice(0, 100) : ''}
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
                    if (!editor) return;
                    const { tr } = editor.state;
                    const commentType = editor.state.schema.marks.comment;
                    for (const { pos, end } of findCommentMarkPositions(editor.state.doc, cardId)) {
                        tr.removeMark(pos, end, commentType);
                    }
                    editor.view.dispatch(tr);
                }}
            />

            <ContextMenuAnchor contextMenu={selectionContextMenu}>
                <CommentMenuItems
                    primitives={{
                        Item: DropdownMenuItem,
                        Sub: DropdownMenuSub,
                        SubTrigger: DropdownMenuSubTrigger,
                        SubContent: DropdownMenuSubContent,
                    }}
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
