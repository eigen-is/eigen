# Sheets App

Collaborative spreadsheet editor in the Eigen workspace.

## Overview

Sheets provides a Google Sheets-like collaborative spreadsheet experience with real-time synchronization using Yjs.

## File Structure

```
apps/sheets/src/
├── components/
│   └── sheets-sidebar.tsx      # App sidebar navigation
├── routes/
│   ├── __root.tsx              # Root route with AppShell
│   ├── _auth._sidebar.shared.$to.tsx  # Shared sheets route
│   └── _auth.sheet.$ownerId.$mountId.$pathId.tsx  # Sheet editor
├── main.tsx                    # App entry point
└── css/
    └── globals.css             # Sheet-specific styles
```

## Implementation Status

**Basic Structure:** Complete
- App shell and routing setup
- Sidebar navigation
- Sheet editor route structure

**Next Steps:** The sheet editor implementation is planned but not yet complete. The app follows the same patterns as Docs and Stickies for:
- Yjs-based real-time collaboration
- Drive storage (`.eigensheets` files)
- ACL-based sharing
- SSE updates

## File Type

| Type | MIME Type | Extension |
|------|-----------|-----------|
| Sheet | `application/eigensheets` | `.eigensheets` |

Sheets are stored as directories with a `data.db` file for Yjs document persistence, similar to other collaborative document types in Eigen.
