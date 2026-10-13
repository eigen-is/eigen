import type { Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Selection } from '@tiptap/pm/state';
import type { Editor, UseEditorOptions } from '@tiptap/react';
import { useEditor } from '@tiptap/react';
import { useAuth } from '@workspace/lib/auth';
import type { ClassifiedSvg } from '@workspace/lib/clipboard';
import {
    classifyPaste,
    clipboardTextItemHasContent,
    hasRichHtmlBeyondMarker,
    materializeClipboardSvg,
    needsReUpload,
    reUploadImage,
} from '@workspace/lib/clipboard';
import { userColor } from '@workspace/lib/constants/colors';
import { getFontName } from '@workspace/lib/constants/fonts';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { BAND_EXCLUDED_NODES, getDocExtensions } from '@workspace/lib/docs/eigendoc';
import {
    isPendingMediaName,
    useCopyToMediaFolder,
    useMediaResolver,
    useUploadFile,
    useZombieMediaSweep,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { EigenClipboardImageItem } from '@workspace/lib/types/clipboard';
import type { DrivePath } from '@workspace/lib/types/drive';
import { renderPresenceCaret } from '@workspace/ui/components/collab';
import { common, createLowlight } from 'lowlight';
import { type DependencyList, useEffect, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import type * as Y from 'yjs';
import { insertEigenItems, writeDocsClipboard } from './clipboard';
import { Figure, type FigureOptions } from './extensions/figure';
import { PageNumber } from './extensions/page-number';
import { EditorTable } from './extensions/table';
import { TableWidthClamp } from './extensions/table-width-clamp';
import { cleanPastedHTML } from './paste';

const lowlight = createLowlight(common);

const NO_CARDS: ReadonlySet<string> = new Set();

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

// The image paths every docs editor shares, each acting on the editor it is given: the body's or a band's.
export function useDocMedia(path: DrivePath) {
    const uploadFile = useUploadFile(path.ownerId, path.mountId);
    const copyToMediaFolder = useCopyToMediaFolder(path.ownerId, path.mountId);
    const { mediaFolderId, startUpload, resolveMediaPath } = useMediaResolver();

    const uploadImage = async (editor: Editor, file: File) => {
        if (!mediaFolderId || !file.type.startsWith('image/')) return;
        const { pendingName, promise } = startUpload(file);
        editor.chain().focus().setFigure({ mediaName: pendingName }).run();
        const result = await promise;
        if (!editor.isDestroyed) swapFigureMediaName(editor, pendingName, result?.name ?? null);
    };

    return {
        mediaFolderId,
        resolveMediaPath,
        uploadImage,
        // A vector SVG payload (or a pasted SVG document) lands as a figure through the exact image-upload path:
        // stored in media/, served as-is, rendered by <image>. Its images are name-referenced (eigen-media:);
        // materialize re-uploads each into our media/ and rewrites the svg's refs before it's stored.
        uploadSvg: async (editor: Editor, { svg, items }: ClassifiedSvg) => {
            if (!mediaFolderId) return;
            await uploadImage(editor, await materializeClipboardSvg(svg, items, mediaFolderId, uploadFile.mutateAsync));
        },
        insertFromDrive: async (editor: Editor, paths: DrivePath[]) => {
            if (!mediaFolderId) return;
            const results = await copyToMediaFolder.mutateAsync({ paths, mediaFolderId }).catch(() => null);
            if (!results || editor.isDestroyed) return;
            for (const result of results) {
                editor.chain().focus().setFigure({ mediaName: result.name }).run();
            }
        },
        replaceImage: async (editor: Editor, file: File) => {
            if (!mediaFolderId || !file.type.startsWith('image/')) return;
            const { pendingName, promise } = startUpload(file);
            // Reset width so the new image's aspect ratio is recomputed on load
            editor.chain().focus().updateFigure({ mediaName: pendingName, width: null }).run();
            const result = await promise;
            if (!editor.isDestroyed) swapFigureMediaName(editor, pendingName, result?.name ?? null);
        },
        replaceFromDrive: async (editor: Editor, paths: DrivePath[]) => {
            if (!mediaFolderId || paths.length === 0) return;
            const replaced = editor.getAttributes('figure').mediaName;
            const result = await copyToMediaFolder.mutateAsync({ paths: [paths[0]], mediaFolderId }).catch(() => null);
            // The selection may have left the figure during the copy; the copied file then stays unreferenced in media/.
            if (result?.[0] && !editor.isDestroyed && editor.isActive('figure', { mediaName: replaced })) {
                editor.chain().focus().updateFigure({ mediaName: result[0].name, width: null }).run();
            }
        },
        // The name a pasted image item is stored under: another document's file is re-uploaded into this
        // one's media/ first, and skipped if that fails rather than falling back to an unresolvable name.
        pastedMediaName: async (item: EigenClipboardImageItem): Promise<string | null> => {
            if (!needsReUpload(item.sourceParentId, mediaFolderId) || !mediaFolderId) return item.mediaName;
            const result = await reUploadImage(
                item.sourcePathId,
                item.sourceOwnerId,
                item.sourceMountId,
                mediaFolderId,
                uploadFile.mutateAsync,
                item.mediaName,
            );
            return result?.mediaName ?? null;
        },
    };
}

export type DocMedia = ReturnType<typeof useDocMedia>;

type DocEditorTarget =
    // The body: its undo manager over the content and the page, and the comment cards a pasted anchor may keep.
    | { undoManager: Y.UndoManager; cardIds: () => ReadonlySet<string> }
    // A band: its root, y-tiptap's own undo over it, and no comments.
    | { field: BandRoot };

type DocEditorOptions = {
    yDoc: Y.Doc;
    editable: boolean;
    target: DocEditorTarget;
    // Null for a read-only band on the page: an unfocused editor clears the caret a band's editor in the panel set
    // in the same fragment.
    caret: { provider: WebsocketProvider; user: { name: string; color: string; userId: string } } | null;
    // A column's border drags with a mouse only: prosemirror-tables reads mouse events, so a finger
    // drags nothing, and a tap beside a border would start a drag that swallows the caret.
    coarsePointer: boolean;
    figure?: Partial<FigureOptions>;
    // An extension named as a schema node or mark takes its place, as the body's comment mark does.
    extensions?: Extensions;
    textColumnWidth: () => number;
    media: () => DocMedia;
    editor: () => Editor | null;
};

// What every docs editor is built from: the schema, a band's without BAND_EXCLUDED_NODES, the node views, the
// collaboration and the clipboard. useDocEditor builds it in a component; a test builds it on its own.
export function docEditorOptions({
    yDoc,
    editable,
    target,
    caret,
    coarsePointer,
    figure,
    extensions = [],
    textColumnWidth,
    media,
    editor,
}: DocEditorOptions): UseEditorOptions {
    const band = 'field' in target;
    const cardIds = band ? () => NO_CARDS : target.cardIds;
    return {
        editable,
        extensions: [
            ...getDocExtensions({
                lowlight,
                exclude: [
                    ...(band ? BAND_EXCLUDED_NODES : []),
                    'figure',
                    'table',
                    'pageNumber',
                    ...extensions.map((extension) => extension.name),
                ],
            }),
            EditorTable.configure({ resizable: !coarsePointer }),
            Figure.configure(figure),
            PageNumber,
            TableWidthClamp,
            ...extensions,
            Collaboration.configure(
                band
                    ? { document: yDoc, field: target.field }
                    : { document: yDoc, yUndoOptions: { undoManager: target.undoManager } },
            ),
            ...(caret
                ? [
                      CollaborationCaret.configure({
                          provider: caret.provider,
                          // userId is what the server's awareness gate checks; without it every frame is dropped
                          user: caret.user,
                          render: (user: Record<string, string>) =>
                              renderPresenceCaret({ name: user.name, color: user.color }),
                      }),
                  ]
                : []),
        ],
        editorProps: {
            attributes: {
                class: 'eigen-prose',
            },
            handleDOMEvents: {
                copy: (view, event) => writeDocsClipboard(view, event, media().resolveMediaPath),
                cut: (view, event) => writeDocsClipboard(view, event, media().resolveMediaPath),
            },
            transformPastedHTML: (html: string) => cleanPastedHTML(html, textColumnWidth(), cardIds()),
            handleDrop: (view, event) => {
                if (!event.dataTransfer) return false;
                const files = Array.from(event.dataTransfer.files);
                const imageFile = files.find((f) => f.type.startsWith('image/'));
                const target = editor();
                if (imageFile && media().mediaFolderId && target) {
                    event.preventDefault();
                    const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
                    if (dropPos) {
                        const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(dropPos.pos)));
                        view.dispatch(tr);
                    }
                    media()
                        .uploadImage(target, imageFile)
                        .catch(() => {});
                    return true;
                }
                return false;
            },
            handlePaste: (_view, event) => {
                const target = editor();
                if (!event.clipboardData || !target) return false;
                const paste = classifyPaste(event.clipboardData);
                const { mediaFolderId, uploadSvg, uploadImage, pastedMediaName } = media();

                if (paste.svg && mediaFolderId) {
                    event.preventDefault();
                    uploadSvg(target, paste.svg).catch(() => {});
                    return true;
                }

                if (paste.eigen) {
                    // Images take this path for the cross-mount re-upload, a docs copy's through its own
                    // HTML; text only when text/html is marker-only (a canvas text copy), so a sheets table
                    // still parses in PM. Claimed only with an item this editor can place, or ⌘V on a bare
                    // `elements` item is dead.
                    const hasImage = paste.eigen.items.some((i) => i.type === 'image');
                    const hasText = paste.eigen.items.some((i) => i.type === 'text' && clipboardTextItemHasContent(i));
                    if (hasImage || (hasText && !hasRichHtmlBeyondMarker(event.clipboardData))) {
                        event.preventDefault();
                        insertEigenItems(target, paste.eigen.items, paste.html, pastedMediaName).catch(() => {});
                        return true;
                    }
                }

                const imageFile = paste.imageFiles[0];
                if (imageFile && mediaFolderId) {
                    event.preventDefault();
                    uploadImage(target, imageFile).catch(() => {});
                    return true;
                }
                return false;
            },
        },
    };
}

// The body's editor and each band's: docEditorOptions with this tab's user, its pointer and the doc's media, plus
// the sweep of pending images a closed tab left and the font-name pass, both per editor.
export function useDocEditor(
    {
        path,
        provider,
        ...options
    }: Omit<DocEditorOptions, 'caret' | 'coarsePointer' | 'media' | 'editor'> & {
        path: DrivePath;
        // Null draws and sets no caret: a read-only band on the page.
        provider: WebsocketProvider | null;
    },
    deps: DependencyList = [],
): Editor {
    const auth = useAuth();
    const coarsePointer = useIsCoarsePointer();
    const media = useDocMedia(path);
    const mediaRef = useRef(media);
    mediaRef.current = media;
    const editorRef = useRef<Editor | null>(null);
    const user = auth.user;
    const editor = useEditor(
        docEditorOptions({
            ...options,
            caret:
                provider && user
                    ? { provider, user: { name: user.name, color: userColor(user.id), userId: user.id } }
                    : null,
            coarsePointer,
            media: () => mediaRef.current,
            editor: () => editorRef.current,
        }),
        deps,
    );
    editorRef.current = editor;

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
    const { editable } = options;
    useEffect(() => {
        if (!editor || !editable) return;
        normalizeFontFamilyMarks(editor);
    }, [editor, editable]);

    return editor;
}
