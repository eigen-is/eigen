# TanStack Hotkeys Analysis

Should Eigen adopt `@tanstack/react-hotkeys`? This document inventories current keyboard handling, evaluates the
library, and provides an implementation plan.

## 1. Current Keyboard Handling Inventory

### 1.1 List Navigation (shared hook)

**File:** `use-keyboard-list-navigation.ts`

- ArrowUp/Down, Shift+Arrow, Ctrl+A, Escape, Enter, Space, Delete, Home/End.
- Element-scoped `onKeyDown`.

### 1.2 Docs Editor (`apps/docs`)

**Files:** `editor.tsx`, `editor-toolbar.tsx`

- Ctrl+B/I/U handled by Slate's `<Editable>` `onKeyDown`.
- Undo/Redo handled natively by `slate-history`.
- Mac detection via `window.navigator.platform`.

### 1.3 Stickies Board (`apps/stickies`)

**File:** `stickies-toolbar.tsx`

- Undo/Redo toolbar buttons. No keyboard shortcut bindings.

### 1.4 Sidebar Toggle (shadcn)

**File:** `sidebar.tsx`

- Ctrl/Cmd+B via global `window.addEventListener`.
- **Conflicts** with Ctrl+B (Bold) in Docs editor.

### 1.5 Print Document

**File:** `use-print-document.ts`

- Ctrl/Cmd+P via global `document.addEventListener`.

### 1.6 File Preview (Escape to close)

**File:** `file-preview.tsx`

- Escape via global `document.addEventListener`.

### 1.7 Resizable Media

**File:** `resizable-media.tsx`

- Escape, Delete, Backspace via global `document.addEventListener`.

### 1.8 Contact Autosuggest

**File:** `contact-autosuggest.tsx`

- ArrowUp/Down, Enter, Escape via `onKeyDown`. Element-scoped.

### 1.9 Dialog Enter-to-submit

**Files:** `drive-create-folder-item.tsx`, `editor-toolbar.tsx`

- Enter key on `<Input>`.

## 2. Pattern Summary

| Pattern                            | Count | Implementation                                     |
|------------------------------------|-------|----------------------------------------------------|
| Element-scoped `onKeyDown`         | 5     | List nav, Slate editor, autosuggest, dialog inputs |
| Global `document.addEventListener` | 3     | Print, file preview Escape, media Escape/Delete    |
| Global `window.addEventListener`   | 1     | Sidebar toggle                                     |
| No keyboard binding                | 1     | Stickies undo/redo                                 |

## 3. TanStack Hotkeys

**Offers:** Cross-platform `Mod` shortcuts, `formatForDisplay`, global defaults, `ignoreInputs` smart default, conflict
detection, auto cleanup.

## 4. Analysis

### What it solves well

- Eliminates manual `metaKey || ctrlKey` and Mac detection checks.
- Replaces manual command-key label construction.
- Solves global shortcut vs input field conflicts.
- Surfaces shortcut conflicts (e.g., sidebar Ctrl+B vs Docs bold).
- Replaces `addEventListener` boilerplate.

### What it does NOT solve

- **`useKeyboardListNavigation`**: This is stateful navigation. Keep as-is.
- **Slate editor**: Slate has its own pipeline. Keep as-is.
- **Contact autosuggest**: Dropdown nav is stateful. Keep as-is.
- **Dialogs**: Standard input `onKeyDown`. Keep as-is.

### Verdict

**Adopt selectively.**

- Use for: global shortcuts, stickies undo/redo, display formatting.
- Do NOT use for: complex stateful navigation, framework-specific pipelines.

## 5. Implementation Plan

### Phase 1: Setup

Add `@tanstack/react-hotkeys`. Wrap `EigenApp` in `HotkeysProvider`.

### Phase 2: Replace global listeners

Use `useHotkey` for:

- Print (`Mod+P`)
- File preview close (`Escape`)
- Resizable media (`Escape`, `Delete`, `Backspace`)
- Sidebar toggle (Change shortcut to avoid Ctrl+B conflict, e.g., `Mod+\`)

### Phase 3: Add missing shortcuts

Add `Mod+Z`, `Mod+Y`, `Mod+Shift+Z` to Stickies board.

### Phase 4: Replace display labels

Use `formatForDisplay` in Docs and Stickies toolbars instead of manual platform checks.
