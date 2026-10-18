import type { Node } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { EditorContent } from '@tiptap/react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { useAuth } from '@workspace/lib/auth';
import { useCollabDoc, useYjsUndoState } from '@workspace/lib/collab';
import {
    findCardIdByChatName,
    useCommentFilter,
    useCommentLifecycle,
    useDocumentPanels,
} from '@workspace/lib/comments';
import type { BandEdge, BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    BAND_ROOTS,
    bandEdge,
    FIRST_PAGE_BAND,
    normalStyleProperties,
    pagePx,
    pageStylesheet,
} from '@workspace/lib/docs/eigendoc';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isImageMime } from '@workspace/lib/types/drive';
import { CollabDocumentGate, Column, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import {
    type CommentContextMenuItem,
    CommentLifecycleDialogs,
    CommentLifecycleMenuItems,
    CommentMenuItems,
    PanelColumn,
} from '@workspace/ui/components/comments';
import { ContextMenuAnchor, DownloadImageMenuItem, useContextMenu } from '@workspace/ui/components/context-menu';
import { DrivePickerWithUpload } from '@workspace/ui/components/drive';
import { DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { PROPERTIES_PANEL_WIDTH_PX } from '@workspace/ui/components/properties-panel';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/search/prosemirror-search-highlight';
import { useElementSize } from '@workspace/ui/hooks/use-element-size';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { ChartDataEditor, ChartPropertiesPanel } from './chart-properties-panel';
import { useBandEditors, useDocEditor, useDocMedia } from './doc-editor';
import { EditorToolbar } from './editor-toolbar';
import { EquationPropertiesPanel } from './equation-properties-panel';
import {
    addCommentAnchor,
    CommentMark,
    commentAnchorText,
    nodeCommentCardId,
    removeCommentAnchors,
    selectCommentAnchor,
    updateCommentDecorations,
} from './extensions/comment-mark';
import { FigurePropertiesPanel } from './figure-properties-panel';
import { useActiveComments } from './hooks/use-active-comments';
import { useNormalStyle } from './hooks/use-normal-style';
import { usePageSetup } from './hooks/use-page-setup';
import { type SelectionPanel, useSelectionPanel } from './hooks/use-selection-panel';
import { updateNormalStyle } from './normal-style';
import { BandControls, PageBands } from './page-band';
import { applyPageNumberPreset, type PageNumberPreset } from './page-numbers';
import { createDocUndoManager, writePageSetup } from './page-setup';
import { TablePropertiesPanel } from './table-properties-panel';

// The panel is an absolute overlay, so it covers all of the scroll box's content box but its p-4 gutter.
const PANEL_INTRUSION_PX = PROPERTIES_PANEL_WIDTH_PX - 16;

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
    // No undoScope: the editor builds its own UndoManager for y-prosemirror's history plugin.
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
                        unsyncedEdits={unsyncedEdits}
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
    unsyncedEdits,
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
    unsyncedEdits: boolean;
    storageUnavailable: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    initialSearchTerm?: string;
}) => {
    const auth = useAuth();
    const media = useDocMedia(path);
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
    // The image panel's button and Format › Image › Replace image open the same picker.
    const [replacePickerOpen, setReplacePickerOpen] = useState(false);
    // The chart panel's Edit data and a double-click on a chart open one dialog, for the selected chart.
    const [chartDataOpen, setChartDataOpen] = useState(false);
    const closeChartData = useCallback(() => setChartDataOpen(false), []);
    const needsScaleRef = useRef(false);
    const documentRef = useRef<HTMLDivElement | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const handleAddCommentRef = useRef<(() => void) | null>(null);
    const allCommentsRef = useRef<CommentEntry[]>([]);
    const cardsRef = useRef<Record<string, CommentCard>>({});
    // The extensions keep the closures they were created with, so the figure menu reads this render's state here.
    const figureContextMenuRef = useRef<(node: Node, pos: number, event: React.MouseEvent) => void>(() => {});
    const editEquationRef = useRef(() => {});
    const [undoManager] = useState(() => createDocUndoManager(yDoc));
    const pageSetup = usePageSetup(yDoc);
    const writeSetup = (from: PageSetup, to: PageSetup) => writePageSetup(yDoc, undoManager, from, to);
    const normalStyle = useNormalStyle(yDoc);
    // The page at 96 dpi, for the layout math below and the text column before the page mounts.
    const page = pagePx(pageSetup);
    // Only the text column has to stay clear of the panel; the page's right margin may tuck under it.
    const textColumnRight = page.width - page.margin.right;

    const commentMenuItem = (cardId: string | null): CommentContextMenuItem | null => {
        const card = cardId ? cardsRef.current[cardId] : undefined;
        if (!card) return null;
        const entry = card.chatName ? allCommentsRef.current.find((c) => c.chatName === card.chatName) : undefined;
        return { card, entry };
    };

    const [setScrollContainer, scrollSize] = useElementSize(scrollContainerRef);
    // Past this the panel clears the centered page outright and every value below is pinned, so the math stops there.
    const panelClearWidth = 2 * (textColumnRight + PANEL_INTRUSION_PX) - page.width;
    const containerWidth = Math.min(scrollSize.width, panelClearWidth);

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

    const editor = useDocEditor(
        {
            media,
            yDoc,
            provider,
            editable: canWrite,
            target: { undoManager, cardIds: () => new Set(Object.keys(cardsRef.current)) },
            figure: {
                onOpenComment: handleCommentClick,
                onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
            },
            chart: {
                onOpenComment: handleCommentClick,
                onContextMenu: (node, pos, event) => figureContextMenuRef.current(node, pos, event),
                onEditData: () => setChartDataOpen(true),
            },
            equation: {
                onOpenComment: handleCommentClick,
                onEdit: isMobile ? undefined : () => editEquationRef.current(),
            },
            extensions: [
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
            ],
        },
        [handleCommentClick, isMobile],
    );
    // The body's editor is built anew with its comment handler, and an upload settles into whichever holds the doc then.
    const editorRef = useRef<Editor | null>(null);
    editorRef.current = editor;

    // The band being edited in place: a writer's, on a desktop or a tablet. Explicit rather than the focused editor,
    // as a menu takes focus when it opens. Losing write access or the desktop leaves it, and a first page's band hands
    // over to the other pages' once Different first page goes off, a collaborator's untick too.
    const bandsAllowed = canWrite && !isMobile;
    const [editingBand, setEditingBand] = useState<BandRoot | null>(null);
    if (editingBand && !bandsAllowed) setEditingBand(null);
    else if (editingBand && !pageSetup.differentFirstPage && editingBand !== bandEdge(editingBand)) {
        setEditingBand(bandEdge(editingBand));
    }
    // Esc puts the caret back where it was in the body.
    const leaveBand = () => {
        setEditingBand(null);
        editor.commands.focus();
    };
    const bands = useBandEditors({
        media,
        yDoc,
        provider,
        editable: canWrite,
        editing: editingBand,
        onLeave: leaveBand,
    });
    const activeEditor = editingBand ? bands[editingBand] : editor;
    // A double-click puts the caret where it was, a menu at the band's end.
    const enterBand = (root: BandRoot, at?: { left: number; top: number }) => {
        setEditingBand(root);
        const band = bands[root];
        band.commands.focus((at && band.view.posAtCoords(at)?.pos) ?? 'end');
    };
    // Page 1's header tops the long page, and the other pages' footer ends it.
    const entryBand = (edge: BandEdge) =>
        edge === 'header' && pageSetup.differentFirstPage ? FIRST_PAGE_BAND.header : edge;
    const applyPreset = (preset: PageNumberPreset) => {
        applyPageNumberPreset(bands, preset, pageSetup, writeSetup);
        enterBand(entryBand(preset.band));
    };
    // An image goes where the caret is and settles into that editor: a band's lives as long as the doc, and the body's
    // is read again once the upload lands.
    const insertTarget = editingBand ? () => bands[editingBand] : () => editorRef.current;

    // From the undo manager's own events: it moves an undone step onto the redo stack after the transaction that undid
    // it, so an editor transaction reads the stacks too early.
    const { canUndo, canRedo } = useYjsUndoState(
        yUndoPluginKey.getState(activeEditor.state)?.undoManager ?? null,
        canWrite,
    );

    const handleAddComment = () => {
        if (!editor || !chatFolderId) return;
        const { from, to } = editor.state.selection;
        const text = commentAnchorText(editor.state.doc, from, to);
        if (!text.trim()) return;
        setPendingMarkRange({ from, to, text });
        setAddOpen(true);
    };
    handleAddCommentRef.current = chatFolderId ? handleAddComment : null;

    const { selectionPanel, equationFieldRef, editEquation, insertEquation } = useSelectionPanel(
        editor,
        isMobile,
        closePanels,
    );
    editEquationRef.current = editEquation;
    const lastPanelRef = useRef<Exclude<SelectionPanel, 'document'>>('figure');
    if (selectionPanel !== 'document') lastPanelRef.current = selectionPanel;

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
        const imagePath = media.resolveMediaPath(node.attrs.mediaName ?? '');
        const comment = commentMenuItem(nodeCommentCardId(node));
        if (!imagePath && !comment && !canAddComment) return;
        // Selected first, so Add comment anchors to it.
        editor?.commands.setNodeSelection(pos);
        figureContextMenu.handleContextMenu(event, { imagePath, comment });
    };

    const removeCommentMarks = (cardId: string) => {
        if (editor) removeCommentAnchors(editor, cardId);
    };

    const handleSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            if (!editor || !pendingMarkRange) return;
            const range = pendingMarkRange;
            const card = await createCard({ title: pendingMarkRange.text, ...patch, attachments }, (card) =>
                addCommentAnchor(editor, range, card.id),
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

    const docSearchController = useProseMirrorSearchController(editor, canWrite);
    // Find searches the body, so ⌘F leaves a band.
    const handleSearchOpenChange = useCallback(
        (open: boolean) => {
            if (open) setEditingBand(null);
            onSearchOpenChange(open);
        },
        [onSearchOpenChange],
    );
    const commentSearchHalf = useDocCommentSearchHalf(path.ownerId, path.mountId, path.id);

    // The figure, chart, equation and table panels follow the body's selection, so a band being edited closes them.
    const showSidebar = !isMobile && (panel !== null || (canWrite && !editingBand && selectionPanel !== 'document'));

    // Slide the centered page left by its overlap with the panel; only shrink once the slack runs out.
    const centredSlack = Math.max(0, (containerWidth - page.width) / 2);
    const panelLeft = containerWidth - PANEL_INTRUSION_PX;
    const panelOverlap = showSidebar ? Math.max(0, centredSlack + textColumnRight - panelLeft) : 0;
    const canShift = containerWidth > 0 && panelOverlap <= centredSlack;
    const canvasShift = canShift ? panelOverlap : 0;
    const canvasScale =
        containerWidth === 0 ? 1 : Math.min(1, containerWidth / page.width, canShift ? 1 : panelLeft / textColumnRight);
    const needsScale = canvasScale < 1;

    // The document observer stays quiet while unscaled, so seed the height on the way in.
    useLayoutEffect(() => {
        needsScaleRef.current = needsScale;
        if (needsScale && documentRef.current) setDocHeight(documentRef.current.offsetHeight);
    }, [needsScale]);

    if (!editor) return null;

    // Desktop reveals the anchor and switches an activity tap over to comments; the mobile pane hides
    // the editor, so it just opens the card.
    const openCard = (cardId: string) => {
        setEditingBand(null);
        if (!isMobile) {
            openComments();
            selectCommentAnchor(editor, cardId);
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
            setEditingBand(null);
            openComments();
            // The mobile pane hides the editor, so scrolling would drive a view nobody can see.
            if (!isMobile) selectCommentAnchor(editor, cardId);
            setOpenCardId(cardId);
        },
    };

    const bandControls = editingBand && (
        <BandControls
            band={editingBand}
            editor={bands[editingBand]}
            setup={pageSetup}
            onSetupChange={writeSetup}
            onDifferentFirstPage={(differentFirstPage) => {
                writeSetup(pageSetup, { ...pageSetup, differentFirstPage });
                // Ticked, what was typed stays the other pages' and the caret goes into page 1's new band, as in Google.
                const edge = bandEdge(editingBand);
                if (differentFirstPage) enterBand(FIRST_PAGE_BAND[edge]);
                else if (editingBand !== edge) enterBand(edge);
            }}
            onPageNumbers={applyPreset}
            onRemove={() => {
                bands[editingBand].commands.clearContent();
                leaveBand();
            }}
        />
    );

    return (
        <>
            <div className="flex h-full w-full overflow-hidden">
                {/* Hiding takes the find bar with it: it floats in this wrapper, outside the pane's Column. */}
                <div className={cn('flex-1 min-w-0 h-full', mobilePanelOpen && 'hidden')}>
                    <DocSearchProvider
                        controller={docSearchController}
                        commentSearch={commentSearch}
                        initialSearchTerm={initialSearchTerm}
                        onOpenChange={handleSearchOpenChange}
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
                                    editor={activeEditor}
                                    body={editor}
                                    path={path}
                                    canWrite={canWrite}
                                    offline={offline}
                                    unsyncedEdits={unsyncedEdits}
                                    storageUnavailable={storageUnavailable}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    pageSetup={pageSetup}
                                    onPageSetupChange={writeSetup}
                                    normalStyle={normalStyle}
                                    onUpdateNormalStyle={() =>
                                        updateNormalStyle(yDoc, undoManager, activeEditor, normalStyle)
                                    }
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    // Always offered: desktop draws the side panel, mobile the Column.
                                    onToggleCommentPanel={toggleComments}
                                    commentPanelOpen={commentPanelOpen}
                                    onToggleActivityPanel={toggleActivity}
                                    activityPanelOpen={activityPanelOpen}
                                    assignedCommentCount={assignedCount}
                                    onImageUpload={
                                        mediaFolderId ? (file) => media.uploadImage(insertTarget, file) : undefined
                                    }
                                    onImagePickFromDrive={
                                        mediaFolderId
                                            ? (paths) => media.insertFromDrive(insertTarget, paths)
                                            : undefined
                                    }
                                    onReplaceImage={() => setReplacePickerOpen(true)}
                                    // Comments anchor in the body only, and the Equation panel edits the body's.
                                    onAddComment={chatFolderId && !editingBand ? handleAddComment : undefined}
                                    onInsertEquation={editingBand ? undefined : insertEquation}
                                    onEnterBand={bandsAllowed ? (edge) => enterBand(entryBand(edge)) : undefined}
                                    onPageNumbers={bandsAllowed ? applyPreset : undefined}
                                />
                            }
                        >
                            <div className="h-full relative overflow-hidden">
                                {/* The page box, and on paper the @page margins in its place; the printed clone matches it too. */}
                                <style>{pageStylesheet(pageSetup, '[data-document]')}</style>
                                <div
                                    ref={setScrollContainer}
                                    className={cn(
                                        'h-full w-full overflow-y-scroll bg-muted p-4',
                                        needsScale && 'overflow-x-hidden',
                                    )}
                                    onClick={(e) => {
                                        if (e.target === scrollContainerRef.current && !editingBand) {
                                            editor.commands.blur();
                                        }
                                    }}
                                    // While a band is edited a press in the body leaves it, the caret where it landed,
                                    // as in Google, and one in another band moves there, as that band is read-only
                                    // until entered; a press anywhere else would focus nothing, leaving the band
                                    // edited with Esc and typing reaching nothing, so it keeps the caret. A portaled
                                    // menu or dialog is the band's own.
                                    onMouseDown={
                                        editingBand
                                            ? (e) => {
                                                  const target = e.target;
                                                  if (
                                                      !(target instanceof Element) ||
                                                      !e.currentTarget.contains(target)
                                                  ) {
                                                      return;
                                                  }
                                                  if (target.closest('[data-page-body]')) {
                                                      setEditingBand(null);
                                                      return;
                                                  }
                                                  const pressed = BAND_ROOTS.find((root) =>
                                                      bands[root].view.dom.contains(target),
                                                  );
                                                  if (pressed === editingBand) return;
                                                  e.preventDefault();
                                                  if (pressed) enterBand(pressed, { left: e.clientX, top: e.clientY });
                                              }
                                            : undefined
                                    }
                                >
                                    <div
                                        data-document="true"
                                        className={cn(
                                            // eigen-paper: the page always renders light, in dark mode too (globals.css)
                                            // Rows: the header band, the body, the footer band.
                                            'eigen-paper grid grid-rows-[auto_1fr_auto] bg-white rounded-lg shadow-sm shadow-transparent print:shadow-none',
                                            !needsScale && 'min-h-full m-auto',
                                        )}
                                        ref={setDocumentEl}
                                        // The doc's Normal, which the body and the bands draw unformatted text in.
                                        style={{
                                            ...normalStyleProperties(normalStyle),
                                            ...(needsScale
                                                ? {
                                                      transform: `scale(${canvasScale})`,
                                                      transformOrigin: 'top left',
                                                      marginBottom: -(1 - canvasScale) * docHeight,
                                                  }
                                                : canvasShift > 0 && { transform: `translateX(${-canvasShift}px)` }),
                                        }}
                                    >
                                        <PageBands
                                            edge="header"
                                            editors={bands}
                                            setup={pageSetup}
                                            editing={editingBand}
                                            onEnter={
                                                bandsAllowed
                                                    ? (root, at) => enterBand(root ?? entryBand('header'), at)
                                                    : undefined
                                            }
                                            controls={bandControls}
                                        />
                                        <EditorContent
                                            editor={editor}
                                            data-page-body
                                            // Dimmed and still editable while a band is edited; printed as it is.
                                            className={cn(
                                                'row-start-2 h-full min-w-0 tiptap-wrapper',
                                                editingBand && 'opacity-50 print:opacity-100',
                                            )}
                                        />
                                        <PageBands
                                            edge="footer"
                                            editors={bands}
                                            setup={pageSetup}
                                            editing={editingBand}
                                            onEnter={
                                                bandsAllowed
                                                    ? (root, at) => enterBand(root ?? entryBand('footer'), at)
                                                    : undefined
                                            }
                                            controls={bandControls}
                                        />
                                    </div>
                                </div>
                                {/* Unmounted when closed. The stable gutter ends the panel left of the scrollbar. */}
                                {showSidebar && (
                                    <div className="pointer-events-none absolute inset-0 overflow-hidden [scrollbar-gutter:stable]">
                                        <div className="pointer-events-auto absolute inset-y-0 right-0">
                                            {panel ? (
                                                <PanelColumn activePanel={panel} {...panelProps} />
                                            ) : lastPanelRef.current === 'figure' ? (
                                                <FigurePropertiesPanel
                                                    editor={editor}
                                                    onReplaceImage={() => setReplacePickerOpen(true)}
                                                />
                                            ) : lastPanelRef.current === 'chart' ? (
                                                <ChartPropertiesPanel
                                                    editor={editor}
                                                    undoManager={undoManager}
                                                    onEditData={() => setChartDataOpen(true)}
                                                />
                                            ) : lastPanelRef.current === 'equation' ? (
                                                <EquationPropertiesPanel editor={editor} fieldRef={equationFieldRef} />
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

            <DrivePickerWithUpload
                open={replacePickerOpen}
                onOpenChange={setReplacePickerOpen}
                title="Replace image"
                canPick={(item) => isImageMime(item.mimeType)}
                onPickFromDrive={(paths) => media.replaceFromDrive(insertTarget, paths)}
                onPickFromDevice={(files) => files[0] && media.replaceImage(insertTarget, files[0])}
                accept="image/*"
            />

            {chartDataOpen && <ChartDataEditor editor={editor} undoManager={undoManager} onClose={closeChartData} />}

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
