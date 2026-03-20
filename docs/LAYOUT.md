# Layout System

> **TLDR**: `AppShell` wraps every app with Topbar + sidebar + content. `ColumnLayout` + `Column` provide responsive
> multi-column layouts — desktop shows all columns, mobile shows only `mobileColumn`. Toolbars are h-12 bars above each
> column. Back navigation via `onBack` prop on `Column`.

## Structure

```
AppShell
├── Topbar              (blue header, app logo, user dropdown)
└── Content Area
    ├── SidebarContainer (collapsible)
    └── ColumnLayout
        ├── Column "list"    (fixed width)
        └── Column "detail"  (flex width)
```

## File Locations

| Component                 | File                                                              |
|---------------------------|-------------------------------------------------------------------|
| AppShell                  | `packages/ui/src/components/layout/app/app-shell.tsx`             |
| EigenApp (provider stack) | `packages/ui/src/components/layout/app/eigen-app.tsx`             |
| ColumnLayout / Column     | `packages/ui/src/components/layout/column-layout.tsx`             |
| LayoutContext             | `packages/ui/src/components/layout/layout-context.tsx`            |
| Topbar                    | `packages/ui/src/components/layout/topbar.tsx`                    |
| SidebarContainer          | `packages/ui/src/components/layout/sidebar/sidebar-container.tsx` |

## AppShell

Every app wraps its root route in `AppShell`:

```tsx
<AppShell
    appName="contacts"
    rootRoute={Route}
    sidebar={({ condensed, isMobile, onClose }) => (
        <ContactsSidebar condensed={condensed} isMobile={isMobile} onClose={onClose} />
    )}
>
    <Outlet />
</AppShell>
```

| Prop          | Type                                  | Description                           |
|---------------|---------------------------------------|---------------------------------------|
| `appName`     | `string`                              | Shown in Topbar and `document.title`  |
| `rootRoute`   | `{ useNavigate }`                     | TanStack Router root route            |
| `sidebar`     | `ReactNode \| (props) => ReactNode`   | Sidebar content (omit for no sidebar) |
| `sidebarMode` | `'collapsible' \| 'hidden' \| 'none'` | Default: `'collapsible'`              |

## EigenApp Provider Stack

`EigenApp` (`packages/ui/src/components/layout/app/eigen-app.tsx`) wraps every app with providers:

HotkeysProvider → TooltipProvider → QueryClientProvider → AuthProvider → SSEProvider → UploadProvider →
PreviewProvider → GlobalHotkeys → Toaster → ReactQueryDevtools

## ColumnLayout & Column

```tsx
<ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
    <Column id="list" width="350px" toolbar={<ListToolbar />}>
        <ContactsList />
    </Column>
    <Column id="detail" width="flex" onBack={handleBackToList} toolbar={<DetailToolbar />}>
        <ContactDetail />
    </Column>
</ColumnLayout>
```

| Column Prop | Type         | Description                                       |
|-------------|--------------|---------------------------------------------------|
| `id`        | `string`     | Must match `mobileColumn` to be visible on mobile |
| `width`     | `string`     | CSS width or `"flex"`                             |
| `toolbar`   | `ReactNode`  | h-12 bar above content                            |
| `onBack`    | `() => void` | Shows ← button on mobile                          |

**Desktop**: All columns visible side-by-side.
**Mobile**: Only `mobileColumn` visible. `onBack` provides back navigation.

## LayoutContext

`useLayout()` provides: `documentTitle`, `setDocumentTitle`, `sidebarOpen`, `setSidebarOpen`, `sidebarMode`,
`isMobile`, `isTablet`.

Convenience hooks: `useSidebar()` → `{sidebarOpen, setSidebarOpen}`. Use `setDocumentTitle()` to update the
browser tab title dynamically (e.g., showing the current document name).

## DriveLayout (Shared)

`DriveLayout` (`packages/ui/src/components/layout/drive/drive-layout.tsx`) is used by Drive, Docs, Stickies apps. Uses
ColumnLayout internally. See [LAYOUT-UI-DRIVE.md](LAYOUT-UI-DRIVE.md).

## Adding a New App

1. Create `__root.tsx` with `AppShell` wrapper
2. Create `_auth.tsx` route guard with `beforeLoad` redirect
3. Define routes with `ColumnLayout` + `Column`
4. Set `mobileColumn` based on URL params
5. Co-locate toolbar components with their views
