# Hotkeys

> **TLDR**: `@tanstack/react-hotkeys` for global shortcuts. `Mod` = Cmd (Mac) / Ctrl (Windows). Manual listeners kept
> for stateful navigation and Tiptap editor. Use `formatForDisplay()` for tooltip labels.

## Implemented

| Shortcut             | Action                      | Location                      |
|----------------------|-----------------------------|-------------------------------|
| `Mod+B`              | Toggle sidebar              | `packages/ui/.../sidebar.tsx` |
| `Mod+P`              | Print                       | `eigen-app.tsx`               |
| `Mod+S`              | Save (Inline Editor)        | `use-editor-save.ts`          |
| `Escape`             | Close preview               | `file-preview.tsx`            |
| `ArrowLeft/Right`    | Navigate preview            | `file-preview.tsx`            |
| `Mod+Z`              | Undo (Stickies, Slides)     | `board.tsx`, `editor.tsx`     |
| `Mod+Y`              | Redo (Stickies, Slides)     | `board.tsx`, `editor.tsx`     |
| `Mod+Shift+Z`        | Redo alt (Stickies, Slides) | `board.tsx`, `editor.tsx`     |
| `Delete`/`Backspace` | Delete selected (Slides)    | `slides/editor.tsx`           |
| `Escape`             | Deselect (Slides)           | `slides/editor.tsx`           |

## Guidelines

**Use `@tanstack/react-hotkeys`** for: global shortcuts, simple actions, display formatting, cross-platform needs.

**Keep manual** for: stateful navigation (`use-keyboard-list-navigation.ts`), framework-specific (Tiptap editor),
simple input fields.

```tsx
import {useHotkey} from '@tanstack/react-hotkeys';
import {formatForDisplay} from '@tanstack/react-hotkeys';

useHotkey('Mod+S', () => save(), {enabled: canSave});
const label = formatForDisplay('Mod+S'); // "⌘S" on Mac, "Ctrl+S" on Windows
```
