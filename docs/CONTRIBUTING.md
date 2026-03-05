# Contributing to Eigen

This guide covers development conventions, architecture patterns, and best practices for contributing to Eigen.

## Overview

Eigen is a self-hosted Google Workspace alternative built with modern web technologies. This document helps new contributors understand the codebase structure and development patterns.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Backend | Elysia + Drizzle ORM |
| Frontend | React + TypeScript |
| Data | TanStack Query |
| Routing | TanStack Router |
| Styling | Tailwind CSS + shadcn/ui |
| Auth | better-auth |

## Project Structure

```
/apps
  /api          # Backend API server
  /admin        # Admin dashboard
  /calendar     # Calendar app
  /chat         # Chat app
  /contacts     # Contacts app
  /docs         # Document editor
  /drive        # File storage
  /index        # Landing page
  /mail         # Email client
  /setup        # Initial setup wizard
  /space        # Team workspace
  /stickies     # Kanban board

/packages
  /lib          # Shared business logic
  /ui           # Reusable UI components (shadcn/ui)
```

## Code Style

- Use **English** for all code and text
- Prefer simple, clean implementations
- Use shadcn defaults for UI components
- Naming conventions:
  - **Routes**: domain-based (`mail`, `drive`, `contacts`)
  - **Functions**: camelCase
  - **Components**: PascalCase

## Key Patterns

### Types & Interfaces

- Always use `type` instead of `interface` (except when methods are involved)
- Define types in `packages/lib/src/types/[domain].ts`
- Import from `@workspace/lib/types/[domain]` or `@workspace/lib/types`
- Check existing types before creating new ones

### API Routes

Routes are grouped by domain in `/apps/api/src/routes/`:

```typescript
// Example: /apps/api/src/routes/drive.ts
export const driveRouter = new Elysia({name: "drive"})
    .use(betterAuth)
    .get("/drive/root/:ownerId", async ({params, user}) => {
        // ...
    }, {auth: true})  // Protected route
```

All protected routes include `{auth: true}`.

### Hooks

Place hooks in `packages/lib/src/lib/[domain]/hooks/use-[name].ts`:

```typescript
// packages/lib/src/lib/drive/hooks/use-drive.ts
export function useFolderContent(ownerId: string, pathId: string) {
    return useQuery({
        queryKey: driveKeys.folder(pathId),
        queryFn: async () => { /* ... */ }
    });
}
```

### Query Keys

Define query keys as objects with consistent structure:

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
};
```

Export invalidation functions alongside hooks for reuse.

### Module Exports

Each domain module has an `index.ts` that re-exports its public API:

```typescript
// packages/lib/src/lib/drive/index.ts
export * from './hooks';
export * from './sse-handlers';
```

Import from `@workspace/lib/[domain]`, not deep paths.

## API Client

Use the Treaty client from `packages/lib/src/lib/api.ts`:

```typescript
import {driveApi, mailApi, contactsApi} from '@workspace/lib/api';

// Type-safe API calls
const response = await driveApi.folder({ownerId})({pathId}).get();
```

## Real-Time Updates (SSE)

Server-Sent Events handle real-time cache invalidation across tabs/devices.

### SSE Handlers (Frontend)

Location: `packages/lib/src/lib/[domain]/sse-handlers.ts`

```typescript
export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    switch (event.type) {
        case SSEventType.DRIVE_FILE_CREATED:
            invalidateItemCreated(queryClient, path.parentId, path.mimeType);
            return true;
        // ...
    }
}
```

### SSE Event Builders (Backend)

Location: `apps/api/src/lib/[domain]/sse-events.ts`

```typescript
export function buildDriveEvent(type: DriveEventType, path: DrivePath): SSEvent {
    return {
        type,
        title: template.title,
        body: template.body(path),
        path,
    };
}
```

### Invalidation Pattern

Create dedicated invalidate functions and call them from both:
1. **SSE handlers** - for cross-tab sync
2. **Mutation `onSuccess` callbacks** - for immediate updates

## File Types

| Type | MIME Type | Extension |
|------|-----------|-----------|
| Document | `application/eigendoc` | `.eigendoc` |
| Stickies | `application/eigenstickies` | `.eigenstickies` |

URL params use hyphens (`application-eigendoc`), database uses slashes.

## State Management

- **Server state**: TanStack Query
- **Local UI state**: React state hooks
- Use appropriate caching strategies (`staleTime`, `gcTime`)

## Development Workflow

```bash
# Run all applications
bun run serve

# Run specific app with API server
bun serve:drive
bun serve:mail
# etc.

# Run TypeScript type check across all packages and apps
bun run typecheck
```

- Run `bun run typecheck` to verify type safety across the entire monorepo
- Update types when changing database schemas
- Invalidate queries when mutating data
- Create custom hooks for reusable data fetching

## Backend Architecture

### Overview

Each user has a **Home** singleton (`apps/api/src/lib/home/home.ts`) that manages:
- Database connections (one SQLite DB per file/purpose)
- SSE event broadcasting via `notify()`
- Domain class instances (Drive, Mail, Contacts)

### Domain Classes

Business logic lives in `apps/api/src/lib/[domain]/[domain].ts`:

| Class | Location | Storage |
|-------|----------|---------|
| `Drive` | `lib/drive/drive.ts` | Mount system with metadata DB + file storage |
| `Mail` | `lib/mail/maildir.ts` | Maildir + SQLite for metadata |
| `Contacts` | `lib/contacts/contacts.ts` | SQLite + avatars directory |

### Storage Backends

Three pluggable backends in `apps/api/src/lib/storage/`:

- **LocalFilesystem** - Full filesystem operations (used by Mail, Contacts)
- **LocalKeyStorage** - Flat UUID-based file storage (used by Drive mounts)
- **S3Storage** - S3-compatible object storage (ready for use)

For detailed storage architecture, see `docs/STORAGE.md`.

## Documentation

Keep code self-documenting:
- Avoid JSDoc-style comments
- Only comment complex business logic
- Use clear, descriptive variable and function names
