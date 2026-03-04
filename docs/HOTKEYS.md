# Hotkeys in Eigen

Eigen uses `@tanstack/react-hotkeys` for cross-platform keyboard shortcuts with automatic conflict detection and cleanup.

## Current Implementation

### TanStack Hotkeys Integration

- **Package**: `@tanstack/react-hotkeys` (installed in `packages/ui`)
- **Features**: Cross-platform `Mod` shortcuts, `formatForDisplay`, conflict detection, auto cleanup
- **Scope**: Used for global shortcuts and simple actions

### Implemented Hotkeys

#### Global Shortcuts

| Shortcut | Action | Implementation |
|----------|--------|----------------|
| `Mod+B` | Toggle sidebar | `SidebarProvider` in `sidebar.tsx` |
| `Mod+P` | Print document | `use-print-document.ts` (manual listener) |
| `Escape` | Close file preview | `FilePreview` component |
| `Escape` | Deselect media | `ResizableMedia` component |
| `Delete`/`Backspace` | Delete selected media | `ResizableMedia` component |

#### Application-Specific

| App | Shortcut | Action | Implementation |
|-----|----------|--------|----------------|
| **Stickies** | `Mod+Z` | Undo | `StickiesToolbar` |
| **Stickies** | `Mod+Y` | Redo | `StickiesToolbar` |
| **Docs** | `Ctrl+B/I/U` | Bold/Italic/Underline | Slate editor (native) |

### Display Labels

- **Stickies**: Uses `formatForDisplay('Mod+Z')` and `formatForDisplay('Mod+Y')` in tooltips
- **Docs**: Uses `formatForDisplay()` for keyboard shortcut labels in toolbar

### Manual Listeners (Legacy)

| Component | Shortcut | Implementation |
|-----------|----------|----------------|
| Print hook | `Mod+P` | `document.addEventListener('keydown')` |
| Docs editor | `Ctrl+B/I/U` | Slate's `<Editable>` `onKeyDown` |

### Unchanged Patterns

| Pattern | Reason |
|---------|--------|
| List navigation | Stateful navigation, keep existing hook |
| Contact autosuggest | Dropdown navigation, stateful |
| Dialog inputs | Standard input `onKeyDown` |
| Slate editor | Framework-specific pipeline |

## Architecture Decisions

### What TanStack Hotkeys Solves

- **Cross-platform support**: Single `Mod` modifier works on Mac/Windows/Linux
- **Conflict detection**: Automatically surfaces shortcut conflicts
- **Input awareness**: Smart defaults for ignoring inputs
- **Display formatting**: Consistent shortcut labels across platforms
- **Cleanup**: Automatic event listener removal

### What Remains Manual

- **Complex stateful navigation**: List navigation has internal state
- **Framework integration**: Slate editor has its own event pipeline
- **Simple inputs**: Dialog submit actions don't need hotkey library

## Implementation Guidelines

### Use TanStack Hotkeys For

- Global shortcuts (sidebar, print, escape actions)
- Simple component actions (undo/redo, delete)
- Display formatting for tooltips
- Cross-platform compatibility needs

### Keep Manual Implementation For

- Stateful navigation patterns
- Framework-specific event handling (Slate)
- Simple input field actions
- Component-scoped navigation

### Adding New Hotkeys

```tsx
import {useHotkey} from '@tanstack/react-hotkeys';

// Simple action
useHotkey('Mod+S', () => save(), {enabled: canSave});

// With display formatting
import {formatForDisplay} from '@tanstack/react-hotkeys';
const shortcut = formatForDisplay('Mod+S');
```

## Migration Status

### ✅ Completed

- Sidebar toggle: `Mod+B` via `useHotkey`
- File preview: `Escape` via `useHotkey`  
- Media controls: `Escape`, `Delete`, `Backspace` via `useHotkey`
- Stickies undo/redo: `Mod+Z`, `Mod+Y` with `formatForDisplay`
- Docs toolbar: `formatForDisplay` for labels

### ⚠️ Partial

- Print document: Still uses manual `addEventListener` (could migrate)

### 🔄 Not Applicable

- List navigation: Keep existing `use-keyboard-list-navigation.ts`
- Slate editor: Keep native Slate handling
- Contact autosuggest: Keep existing dropdown logic
