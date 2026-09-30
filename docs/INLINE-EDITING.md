# Inline File Editing in Drive

> **TLDR:** Drive edits plain text files in place at `/drive/edit/:ownerId/:mountId/:pathId`: markdown in a Tiptap WYSIWYG editor with a CodeMirror source mode, every other text format in CodeMirror 6. The server side is `apps/api/src/routes/editor.ts` over `apps/api/src/lib/drive/inline-edit.ts`, the client `apps/drive/src/components/editor/`. Not obvious from the code: saving is explicit with no auto-save, a save is guarded by the file's `updatedAt` rather than a lock, the client and the server decide editability from two different lists, and markdown frontmatter never reaches the WYSIWYG editor.

## A file opens read-only, and Edit needs write access

Drive opens a file at the inline-edit route when `isInlineEditable(mimeType, name)` accepts it (`getDriveItemUrl`). The page starts in view mode, which renders the server's text preview, the same body the Drive preview shows. The Edit button shows only when `useCheckPermissions` reports write access. Edit mode mounts the editor on the content from `GET /editor/.../content`, and the heavy editors load lazily (`native-file-editor.tsx`).

## Two lists decide what is editable

The client asks `isInlineEditable` (`packages/lib/src/types/drive.ts`): a MIME list plus the extension list it shares with the code preview. The server asks `getTextPreviewMode` (`packages/lib/src/constants/preview.ts`), which also picks the edit mode (`markdown`, `plaintext` or `code`) on both sides. The server refuses a file it has no mode for with a 400. It checks on save as well as on read, because otherwise a write collaborator could overwrite a binary, such as a container's `data.db`, with text.

## A read refuses bytes it can't round-trip

The read decodes with strict UTF-8 (`TextDecoder` with `fatal: true`) and answers 400 on invalid bytes. A lossy decode would replace them silently, and the next save would write the replacements back over the file. Read and save share one 5 MB cap (`MAX_INLINE_EDIT_SIZE`), so a save never produces a file the next open would refuse.

## Frontmatter stays out of the WYSIWYG editor

For markdown the server splits a leading `---` YAML block off the body (`extractFrontmatter`) and returns it separately. The editor edits the body only, and the save reattaches the block unchanged. A markdown parser would read the fence as a rule or a heading and lose the YAML.

## A save is guarded by `updatedAt`, not a lock

The client sends the `updatedAt` it loaded as `expectedUpdatedAt`. When the file has changed since, the save writes nothing and answers `{ conflict: true }` with the current timestamp. `ConflictDialog` then offers Overwrite (the same save with `force`), Reload or Download your version. Before it writes, the route runs `enforceMountQuota` with the new size and the old one, so a save can also fail on quota. The route composes `prepareSaveContent` with `Drive.writeFileContent`, and access goes through `getSharedDrive`.

## Saving is explicit

There is no auto-save: the file changes on disk only when the user saves. `use-editor-save.ts` owns the whole save story:

- `Mod+S` saves and stays in edit mode. The toolbar's Save runs the same save, then returns to view mode.
- A `beforeunload` guard warns when the buffer is dirty and the tab closes.
- `confirmClose` gates both the Back arrow and Cancel behind a discard dialog when the buffer is dirty, and passes straight through when it is clean.
- A conflict response opens `ConflictDialog`.

## Both editors host the find bar

The markdown editor implements the `DocSearchController` contract with `useProseMirrorSearchController`, the controller the docs app uses, in WYSIWYG mode, and with `use-codemirror-search-controller.ts` in source mode. The code editor uses the CodeMirror one. See [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md).

## See also

- [PREVIEWS.md](PREVIEWS.md): the text preview view mode renders
- [QUOTA.md](QUOTA.md): what `enforceMountQuota` counts
