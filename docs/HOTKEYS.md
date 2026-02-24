# TanStack Hotkeys Analysis

Should Eigen adopt `@tanstack/react-hotkeys`? This document inventories all current keyboard handling, evaluates the library, and provides an implementation plan.

---

## 1. Current Keyboard Handling Inventory

### 1.1 List Navigation (shared hook)

**File:** `packages/ui/src/hooks/use-keyboard-list-navigation.ts`

| Shortcut | Action |
|----------|--------|
| ArrowUp / ArrowDown | Move selection |
| Shift+Arrow | Range select (with `useListSelection`) |
| Ctrl/Cmd+A | Select all |
| Escape | Clear selection |
| Enter / Space | Activate item |
| Delete | Delete item |
| Home / PageUp | Jump to first |
| End / PageDown | Jump to last |

**Used by:** `DriveTable`, `EmailList`, `ContactsList` (3 lists, identical pattern).

**How it works:** Returns a `handleKeyDown` callback attached to the container via `onKeyDown={handleKeyDown}`. This is *element-scoped* keyboard handling — it only fires when the container has focus.

### 1.2 Docs Editor (`apps/docs`)

**File:** `apps/docs/src/components/docs/editor.tsx`

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+B | Bold |
| Ctrl/Cmd+I | Italic |
| Ctrl/Cmd+U | Underline |

Implemented as an `onKeyDown` handler on Slate's `<Editable>` component. Undo/Redo (Ctrl+Z / Ctrl+Y) is handled natively by `slate-history` — no custom keyboard code.

**File:** `apps/docs/src/components/docs/editor-toolbar.tsx`

Undo/Redo toolbar buttons display `commandKey+Z` / `commandKey+Y` labels and call `HistoryEditor.undo(editor)` / `HistoryEditor.redo(editor)`. The `commandKey` is detected via `window.navigator.platform.includes('Mac')`.

### 1.3 Stickies Board (`apps/stickies`)

**File:** `apps/stickies/src/components/dnd-board/stickies-toolbar.tsx`

Undo/Redo toolbar buttons with `commandKey+Z` / `commandKey+Y` labels, calling `undoManager.undo()` / `undoManager.redo()` (Yjs UndoManager). Same `window.navigator.platform` detection pattern as Docs.

**No keyboard shortcut bindings for undo/redo** — the buttons exist but there is no `onKeyDown` or `addEventListener('keydown')` that triggers them. The Yjs UndoManager does not automatically bind to keyboard events.

### 1.4 Sidebar Toggle (shadcn)

**File:** `packages/ui/src/components/sidebar.tsx`

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+B | Toggle sidebar |

Implemented via `window.addEventListener("keydown", ...)` in a `useEffect`. Note: this **conflicts** with Ctrl+B = Bold in the Docs editor when the sidebar is present.

### 1.5 Print Document

**File:** `packages/ui/src/hooks/use-print-document.ts`

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+P | Print document |

Implemented via `document.addEventListener("keydown", ...)` in a `useEffect`.

### 1.6 File Preview (Escape to close)

**File:** `packages/ui/src/components/layout/drive/file-preview.tsx`

| Shortcut | Action |
|----------|--------|
| Escape | Close preview |

Implemented via `document.addEventListener("keydown", ...)`.

### 1.7 Resizable Media (image selection)

**File:** `packages/ui/src/components/layout/media/resizable-media.tsx`

| Shortcut | Action |
|----------|--------|
| Escape | Deselect image |
| Delete / Backspace | Delete image |

Implemented via `document.addEventListener("keydown", ...)`.

### 1.8 Contact Autosuggest

**File:** `packages/ui/src/components/layout/contacts/contact-autosuggest.tsx`

| Shortcut | Action |
|----------|--------|
| ArrowUp / ArrowDown | Navigate suggestions |
| Enter | Select suggestion |
| Escape | Close dropdown |

Implemented as an `onKeyDown` handler on the `<input>` element. Element-scoped.

### 1.9 Dialog Enter-to-submit

**Files:** `drive-create-folder-item.tsx`, `editor-toolbar.tsx` (link dialog)

Enter key on `<Input>` elements to submit forms. Standard `onKeyDown` on the input.

---

## 2. Pattern Summary

| Pattern | Count | Implementation |
|---------|-------|---------------|
| Element-scoped `onKeyDown` handler | 5 | List nav, Slate editor, autosuggest, dialog inputs |
| Global `document.addEventListener('keydown')` | 3 | Print, file preview Escape, media Escape/Delete |
| Global `window.addEventListener('keydown')` | 1 | Sidebar toggle |
| No keyboard binding (toolbar-only) | 1 | Stickies undo/redo (missing keyboard shortcut) |

**Cross-platform handling:** Manual `(e.metaKey || e.ctrlKey)` checks in every handler. Display labels use manual `window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'` detection.

---

## 3. TanStack Hotkeys — What It Offers

**Status:** Alpha (API may change). ~11k npm downloads, 321 GitHub stars.

| Feature | Description |
|---------|-------------|
| `useHotkey('Mod+S', callback)` | Cross-platform shortcut (`Mod` = Cmd on Mac, Ctrl on Win/Linux) |
| `useHotkeySequence` | Vim-style multi-key sequences |
| `useHotkeyRecorder` | Interactive shortcut capture for settings UIs |
| `useHeldKeys` / `useKeyHold` | Real-time key state tracking |
| `formatForDisplay('Mod+S')` | Platform-aware display formatting (`⌘S` vs `Ctrl+S`) |
| `HotkeysProvider` | Global default options for all hooks |
| `target` option | Scope hotkeys to specific elements via refs |
| `ignoreInputs` | Smart default: Mod shortcuts fire in inputs, single keys don't |
| `enabled` option | Conditional hotkeys |
| `conflictBehavior` | Detect duplicate hotkey registrations |
| Devtools | Inspect all registered hotkeys in real-time |
| Stale closure prevention | Callback auto-syncs on every render |
| Auto cleanup | Unregisters on unmount |

**Install:** `bun add @tanstack/react-hotkeys`

---

## 4. Honest Analysis

### 4.1 What TanStack Hotkeys solves well

- **Cross-platform `Mod` abstraction** — Eliminates every `(e.metaKey || e.ctrlKey)` check and every `window.navigator.platform.includes('Mac')` detection
- **`formatForDisplay`** — Replaces manual command-key label construction in `editor-toolbar.tsx` and `stickies-toolbar.tsx`
- **`ignoreInputs` smart defaults** — Would fix the subtle issue where global shortcuts (sidebar toggle, print) could theoretically conflict with typing in inputs
- **Conflict detection** — The sidebar's Ctrl+B binding *conflicts* with the Docs editor's Ctrl+B for Bold. TanStack Hotkeys' `conflictBehavior: 'warn'` would surface this during development
- **Lifecycle management** — Auto-cleanup replaces manual `addEventListener` / `removeEventListener` boilerplate
- **Consistent API** — One pattern instead of three (element `onKeyDown`, `document.addEventListener`, `window.addEventListener`)
- **Devtools** — Useful for debugging which shortcuts are active

### 4.2 What TanStack Hotkeys does NOT solve

- **`useKeyboardListNavigation`** — This hook manages complex *stateful navigation* (selected index, scroll-to-row, selection ranges). TanStack Hotkeys handles individual shortcut → callback mappings. Replacing the list navigation hook with `useHotkey` calls would be **awkward and worse**. The current hook is well-designed for its purpose.
- **Slate editor shortcuts** — Slate has its own keyboard handling pipeline via the `onKeyDown` prop on `<Editable>`. The Ctrl+B/I/U shortcuts are deeply integrated with Slate's editor model. Moving these to `useHotkey` would fight the framework.
- **Contact autosuggest** — Dropdown navigation (ArrowUp/Down/Enter/Escape) is tightly coupled to component state. Same situation as list navigation.
- **Dialog Enter-to-submit** — Standard input `onKeyDown` patterns that don't benefit from a hotkey library.

### 4.3 Risk: Alpha status

TanStack Hotkeys is explicitly **alpha**. The API may change. For a production workspace app, this is a real risk. That said, TanStack has a strong track record with Query, Router, and Table — all of which Eigen already uses. The library is likely to stabilize.

### 4.4 Verdict

**Yes, adopt it — but selectively.** Use TanStack Hotkeys for:
- Global/app-level shortcuts (print, sidebar toggle, Escape-to-close)
- New shortcut features (undo/redo in Stickies, search, navigation)
- Display formatting (`formatForDisplay`)

**Do NOT refactor:**
- `useKeyboardListNavigation` — Keep as-is
- Slate editor `onKeyDown` — Keep as-is (framework-specific)
- Contact autosuggest — Keep as-is (element-scoped dropdown nav)
- Dialog input handlers — Keep as-is

---

## 5. Implementation Plan

### Phase 1: Install and set up provider

Add `@tanstack/react-hotkeys` to the workspace. Add `HotkeysProvider` to `EigenApp` root wrapper.

```
bun add @tanstack/react-hotkeys
```

```tsx
// packages/ui/src/components/layout/eigen-app.tsx (pseudocode)
import { HotkeysProvider } from '@tanstack/react-hotkeys'

// Wrap existing providers:
<HotkeysProvider>
  <QueryClientProvider>
    {/* ... existing providers ... */}
  </QueryClientProvider>
</HotkeysProvider>
```

### Phase 2: Replace global `addEventListener` shortcuts

**2a. Print document** — `packages/ui/src/hooks/use-print-document.ts`

```tsx
// BEFORE
export function usePrintDocument() {
    useEffect(() => {
        const onKeydown = (event: KeyboardEvent) => {
            const {key, ctrlKey, metaKey} = event;
            if ((metaKey || ctrlKey) && key === 'p') {
                printDocument();
                event.preventDefault();
            }
        }
        document.addEventListener('keydown', onKeydown);
        return () => document.removeEventListener('keydown', onKeydown);
    }, []);
}

// AFTER
import { useHotkey } from '@tanstack/react-hotkeys'

export function usePrintDocument() {
    useHotkey('Mod+P', () => {
        printDocument();
    });
}
```

**2b. File preview Escape** — `packages/ui/src/components/layout/drive/file-preview.tsx`

```tsx
// BEFORE
useEffect(() => {
    const handleEscapeKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscapeKey);
    return () => document.removeEventListener("keydown", handleEscapeKey);
}, [onClose]);

// AFTER
import { useHotkey } from '@tanstack/react-hotkeys'

useHotkey('Escape', () => onClose(), { enabled: open });
```

**2c. Resizable media** — `packages/ui/src/components/layout/media/resizable-media.tsx`

```tsx
// BEFORE (inside useEffect with document.addEventListener)
const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDeselect();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
        e.preventDefault();
        onDelete();
    }
};

// AFTER
useHotkey('Escape', () => onDeselect(), { enabled: isSelected });
useHotkey('Delete', () => onDelete?.(), { enabled: isSelected && !!onDelete });
useHotkey('Backspace', () => onDelete?.(), { enabled: isSelected && !!onDelete });
```

**2d. Sidebar toggle** — `packages/ui/src/components/sidebar.tsx`

```tsx
// BEFORE (window.addEventListener in useEffect)
const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
    }
};

// AFTER
import { useHotkey } from '@tanstack/react-hotkeys'

useHotkey(`Mod+${SIDEBAR_KEYBOARD_SHORTCUT}`, () => toggleSidebar());
```

> **Note:** This currently binds Ctrl/Cmd+B which conflicts with Bold in the Docs editor. Consider changing to a non-conflicting shortcut (e.g., `Mod+\\` or `Mod+[`). TanStack Hotkeys will log a warning about the conflict.

### Phase 3: Add missing keyboard shortcuts

**3a. Stickies undo/redo** — Currently only toolbar buttons, no keyboard binding.

```tsx
// apps/stickies/src/components/dnd-board/board.tsx (pseudocode)
import { useHotkey } from '@tanstack/react-hotkeys'

// Inside StickiesBoard component:
useHotkey('Mod+Z', () => undoManager?.undo(), { enabled: canWrite && !!undoManager });
useHotkey('Mod+Y', () => undoManager?.redo(), { enabled: canWrite && !!undoManager });
useHotkey('Mod+Shift+Z', () => undoManager?.redo(), { enabled: canWrite && !!undoManager });
```

### Phase 4: Replace display label construction

**4a. Docs editor toolbar** — `apps/docs/src/components/docs/editor-toolbar.tsx`

```tsx
// BEFORE
const [commandKey, setCommandKey] = useState('⌘');
useEffect(() => {
    setCommandKey(window.navigator.platform.includes('Mac') ? '⌘' : 'Ctrl');
}, []);
// usage: tooltipText={`Undo (${commandKey}+Z)`}

// AFTER
import { formatForDisplay } from '@tanstack/react-hotkeys'
// usage: tooltipText={`Undo (${formatForDisplay('Mod+Z')})`}
// No state needed, no useEffect needed.
```

**4b. Stickies toolbar** — `apps/stickies/src/components/dnd-board/stickies-toolbar.tsx`

Same pattern — replace `window.navigator.platform` check with `formatForDisplay`.

### Phase 5 (optional): Devtools

Add devtools for development builds:

```tsx
// packages/ui/src/components/layout/eigen-app.tsx (pseudocode)
import { TanStackDevtools } from '@tanstack/react-devtools'
import { hotkeysDevtoolsPlugin } from '@tanstack/react-hotkeys-devtools'

// In development only:
{process.env.NODE_ENV === 'development' && (
    <TanStackDevtools plugins={[hotkeysDevtoolsPlugin()]} />
)}
```

---

## 6. Files Changed Summary

### Phase 1
| File | Change |
|------|--------|
| `package.json` (root or packages/ui) | Add `@tanstack/react-hotkeys` |
| `packages/ui/src/components/layout/eigen-app.tsx` | Wrap with `HotkeysProvider` |

### Phase 2 (replace existing)
| File | Change |
|------|--------|
| `packages/ui/src/hooks/use-print-document.ts` | Replace `addEventListener` with `useHotkey` |
| `packages/ui/src/components/layout/drive/file-preview.tsx` | Replace `addEventListener` with `useHotkey` |
| `packages/ui/src/components/layout/media/resizable-media.tsx` | Replace `addEventListener` with `useHotkey` |
| `packages/ui/src/components/sidebar.tsx` | Replace `addEventListener` with `useHotkey` |

### Phase 3 (add missing)
| File | Change |
|------|--------|
| `apps/stickies/src/components/dnd-board/board.tsx` | Add `useHotkey` for undo/redo |

### Phase 4 (display labels)
| File | Change |
|------|--------|
| `apps/docs/src/components/docs/editor-toolbar.tsx` | Replace `commandKey` state with `formatForDisplay` |
| `apps/stickies/src/components/dnd-board/stickies-toolbar.tsx` | Replace `commandKey` with `formatForDisplay` |

### DO NOT change
| File | Reason |
|------|--------|
| `packages/ui/src/hooks/use-keyboard-list-navigation.ts` | Stateful list navigation, not a hotkey use case |
| `packages/ui/src/hooks/use-list-selection.ts` | Mouse + modifier key selection, not hotkeys |
| `apps/docs/src/components/docs/editor.tsx` | Slate's own `onKeyDown` pipeline |
| `packages/ui/src/components/layout/contacts/contact-autosuggest.tsx` | Element-scoped dropdown navigation |
| Dialog `onKeyDown` handlers | Standard input submission patterns |

---

## 7. Known Issue: Sidebar Ctrl+B Conflict

The shadcn sidebar component binds `Ctrl/Cmd+B` globally via `SIDEBAR_KEYBOARD_SHORTCUT`. The Docs editor also uses `Ctrl/Cmd+B` for Bold. When both are active, the sidebar toggle fires on `window` before the editor's `onKeyDown` can handle it.

**Recommendation:** Change the sidebar shortcut to a non-conflicting key (e.g., `Mod+\\` or `Mod+[`) as part of the migration.
