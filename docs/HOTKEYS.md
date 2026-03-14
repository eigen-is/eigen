# Hotkeys

> **TLDR**: `@tanstack/react-hotkeys` for global shortcuts. `Mod` = Cmd (Mac) / Ctrl (Windows). Manual listeners kept
> for stateful navigation and Slate editor. Use `formatForDisplay()` for tooltip labels.

## Implemented

| Shortcut             | Action                   | Location                        |
|----------------------|--------------------------|---------------------------------|
| `Mod+B`              | Toggle sidebar           | `sidebar.tsx`                   |
| `Mod+P`              | Print                    | `eigen-app.tsx`                 |
| `Escape`             | Close preview / deselect | `FilePreview`, `ResizableMedia` |
| `Delete`/`Backspace` | Delete selected media    | `ResizableMedia`                |
| `Mod+Z` / `Mod+Y`    | Undo/Redo (Stickies)     | `StickiesToolbar`               |

## Guidelines

**Use `@tanstack/react-hotkeys`** for: global shortcuts, simple actions, display formatting, cross-platform needs.

**Keep manual** for: stateful navigation (`use-keyboard-list-navigation.ts`), framework-specific (Slate editor), simple
input fields.

```tsx
import {useHotkey} from '@tanstack/react-hotkeys';
import {formatForDisplay} from '@tanstack/react-hotkeys';

useHotkey('Mod+S', () => save(), {enabled: canSave});
const label = formatForDisplay('Mod+S'); // "⌘S" on Mac, "Ctrl+S" on Windows
```
