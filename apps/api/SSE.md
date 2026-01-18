# Server-Sent Events (SSE) Architecture

> Documentation for the SSE notification system, based on the Drive implementation. Use this as reference when adding SSE support to Mail, Contacts, and other apps.

## Overview

The SSE system provides real-time notifications and cache invalidation across the application. When a user performs an action (e.g., uploads a file), other browser tabs and potentially other users receive updates via SSE.

```
User Action → API Mutation → emit SSEvent → SSE Stream → Client Handler
                                                              ↓
                                                    ┌─────────┴─────────┐
                                                    │                   │
                                              Cache Invalidation    Toast Notification
```

---

## 1. Type Definitions

All SSE types are defined in `@workspace/lib/types/sse.ts`:

```typescript
// Event type constants
export const SSEventType = {
    // Mail events
    MAIL_RECEIVED: 'mail:received',
    
    // Drive events
    DRIVE_FOLDER_CREATED: 'drive:folder-created',
    DRIVE_FILE_UPLOADED: 'drive:file-uploaded',
    DRIVE_FOLDER_DELETED: 'drive:folder-deleted',
    // ... more events
} as const;

// Base event structure
type SSEventBase = {
    title: string;
};

// Notification mixin (events that show toasts)
export type SSEventNotification = {
    body: string;
    tag?: string;   // For deduplication
    link?: string;  // Clickable action
};

// Drive events include the full path object
type SSEventDrive = SSEventBase & SSEventNotification & {
    type: `drive:${string}`;
    path: DrivePath;
};

// Union of all events
export type SSEvent = SSEventDrive | SSEventMail;
```

### Key Design Decisions

1. **All events have `title`** - Used for toast headings
2. **Notification events have `body`** - Checked via `isSSEventNotification()` type guard
3. **Domain-specific data** - Drive uses `path: DrivePath`, Mail could use `email: Email`
4. **Type prefixes** - Events are namespaced (`drive:`, `mail:`, `contacts:`)

---

## 2. Backend: Emitting Events

### 2.1 Event Templates

Create a templates file for centralized, localizable text:

```typescript
// apps/api/src/lib/drive/sse-events.ts
import type {DrivePath} from '@workspace/lib/types/drive';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type EventTemplate = {
    title: string;
    body: (path: DrivePath, extra?: string) => string;
};

const templates: Record<string, EventTemplate> = {
    [SSEventType.DRIVE_FILE_UPLOADED]: {
        title: 'File uploaded',
        body: (p) => `File "${p.name}" uploaded`
    },
    // ... more templates
};

export function buildDriveEvent(
    type: DriveEventType, 
    path: DrivePath, 
    options?: {tag?: string; link?: string; extra?: string}
): SSEvent {
    const template = templates[type];
    return {
        type,
        title: template.title,
        body: template.body(path, options?.extra),
        path,
        ...(options?.tag && {tag: options.tag}),
        ...(options?.link && {link: options.link}),
    } as SSEvent;
}
```

### 2.2 Emitting from Business Logic

In your domain class (e.g., `Drive`), add an `emit` helper:

```typescript
// apps/api/src/lib/drive/drive.ts
export default class Drive {
    private home: HomeInterface;
    
    private emit(type: DriveEventType, path: DrivePath, options?: EventOptions): void {
        this.home.notify(buildDriveEvent(type, path, options));
    }
    
    async uploadFile(parentId: string, file: File): Promise<string> {
        // ... upload logic ...
        
        const uploadedFile = await this.mount.getPath(fileId);
        if (uploadedFile) this.emit(SSEventType.DRIVE_FILE_UPLOADED, uploadedFile);
        
        return fileId;
    }
}
```

### 2.3 Home.notify()

The `Home` class manages SSE subscriptions and broadcasts:

```typescript
// apps/api/src/lib/home/home.ts
export class Home implements HomeInterface {
    private sseListeners: Set<(event: SSEvent) => void> = new Set();
    
    public subscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.add(listener);
    }
    
    public unsubscribeSSE(listener: (event: SSEvent) => void): void {
        this.sseListeners.delete(listener);
    }
    
    public notify(event: SSEvent): void {
        for (const listener of this.sseListeners) {
            listener(event);
        }
    }
}
```

---

## 3. Frontend: Receiving Events

### 3.1 useSSE Hook

The `useSSE` hook establishes the EventSource connection:

```typescript
// packages/lib/src/lib/sse/hooks/use-sse.ts
export function useSSE(options: UseSSEOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const {onNotification} = options;

    const handleEvent = useCallback((event: SSEvent) => {
        // Call notification handler for toast-worthy events
        if (isSSEventNotification(event)) {
            onNotification?.(event);
        }

        // Dispatch to domain-specific handlers for cache invalidation
        handleDriveSSEvent(event, queryClient);
        handleMailSSEvent(event, queryClient);
    }, [onNotification, queryClient]);

    useEffect(() => {
        if (!isAuthenticated) return;
        
        const eventSource = new EventSource(SSE_EVENTS_URL, {withCredentials: true});
        
        eventSource.onmessage = (event) => {
            const sseEvent = JSON.parse(event.data) as SSEvent;
            handleEvent(sseEvent);
        };

        return () => eventSource.close();
    }, [isAuthenticated, handleEvent]);
}
```

### 3.2 SSE Handlers (Cache Invalidation)

Each domain has its own handler that invalidates relevant caches:

```typescript
// packages/lib/src/lib/drive/sse-handlers.ts
export function handleDriveSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('drive:')) return false;
    if (!('path' in event)) return false;

    const {path} = event;

    switch (event.type) {
        case SSEventType.DRIVE_FILE_UPLOADED:
            if (path.parentId) {
                queryClient.invalidateQueries({queryKey: driveKeys.folder(path.parentId)});
            }
            invalidateHomeSize(queryClient);
            return true;
            
        case SSEventType.DRIVE_FILE_DELETED:
            queryClient.invalidateQueries({queryKey: driveKeys.folders()});
            queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
            invalidateHomeSize(queryClient);
            return true;
            
        // ... more cases
    }
    return false;
}
```

### 3.3 SSEProvider (Toast Notifications)

The `SSEProvider` component wraps `useSSE` and displays toasts:

```typescript
// packages/ui/src/components/layout/sse-provider/sse-provider.tsx
export function SSEProvider({children}: {children: React.ReactNode}) {
    useSSE({
        onNotification: (event) => {
            const title = event.title.slice(0, 50);
            const body = event.body.slice(0, 120);
            
            toast(title, {
                description: body,
                action: event.link ? {
                    label: 'View',
                    onClick: () => window.location.href = event.link!
                } : undefined
            });
        }
    });
    
    return <>{children}</>;
}
```

---

## 4. Adding SSE to a New Domain (e.g., Contacts)

### Step 1: Define Event Types

```typescript
// packages/lib/src/types/sse.ts
export const SSEventType = {
    // ... existing events
    
    // Contacts events
    CONTACTS_CREATED: 'contacts:created',
    CONTACTS_UPDATED: 'contacts:updated',
    CONTACTS_DELETED: 'contacts:deleted',
} as const;

// Add contacts event type
type SSEventContacts = SSEventBase & SSEventNotification & {
    type: `contacts:${string}`;
    contact: Contact;  // Your domain type
};

export type SSEvent = SSEventDrive | SSEventMail | SSEventContacts;
```

### Step 2: Create Event Templates

```typescript
// apps/api/src/lib/contacts/sse-events.ts
const templates = {
    [SSEventType.CONTACTS_CREATED]: {
        title: 'Contact added',
        body: (c: Contact) => `${c.name} added to contacts`
    },
    // ...
};

export function buildContactsEvent(type, contact, options?): SSEvent { ... }
```

### Step 3: Emit Events from Business Logic

```typescript
// apps/api/src/lib/contacts/contacts.ts
export class Contacts {
    private emit(type, contact, options?) {
        this.home.notify(buildContactsEvent(type, contact, options));
    }
    
    async addContact(data): Promise<Contact> {
        const contact = await this.db.insert(...);
        this.emit(SSEventType.CONTACTS_CREATED, contact);
        return contact;
    }
}
```

### Step 4: Create SSE Handler

```typescript
// packages/lib/src/lib/contacts/sse-handlers.ts
export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event.type.startsWith('contacts:')) return false;
    
    switch (event.type) {
        case SSEventType.CONTACTS_CREATED:
        case SSEventType.CONTACTS_UPDATED:
        case SSEventType.CONTACTS_DELETED:
            queryClient.invalidateQueries({queryKey: contactKeys.lists()});
            return true;
    }
    return false;
}
```

### Step 5: Register Handler in useSSE

```typescript
// packages/lib/src/lib/sse/hooks/use-sse.ts
const handleEvent = useCallback((event: SSEvent) => {
    if (isSSEventNotification(event)) {
        onNotification?.(event);
    }

    handleDriveSSEvent(event, queryClient);
    handleMailSSEvent(event, queryClient);
    handleContactsSSEvent(event, queryClient);  // Add new handler
}, [onNotification, queryClient]);
```

### Step 6: Remove Toast Calls from UI

Remove `toast.success()` calls from mutation `onSuccess` handlers - SSE will handle them.

### Step 7: Remove Duplicate Cache Invalidation

Remove `queryClient.invalidateQueries()` from mutation hooks - SSE handlers will handle them.

---

## 5. Summary

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Types | `packages/lib/src/types/sse.ts` | Event type definitions |
| Templates | `apps/api/src/lib/{domain}/sse-events.ts` | Text strings + event builder |
| Emit | `apps/api/src/lib/{domain}/{domain}.ts` | Call `this.emit()` after mutations |
| Broadcast | `apps/api/src/lib/home/home.ts` | `notify()` sends to all subscribers |
| Receive | `packages/lib/src/lib/sse/hooks/use-sse.ts` | EventSource connection |
| Invalidate | `packages/lib/src/lib/{domain}/sse-handlers.ts` | Cache invalidation logic |
| Toast | `packages/ui/.../sse-provider.tsx` | Display notifications |

### Benefits

- **Centralized toast notifications** - No scattered `toast.success()` calls
- **Centralized cache invalidation** - No duplicate `invalidateQueries()` calls
- **Cross-tab sync** - Changes in one tab update others automatically
- **Cross-app notifications** - Get Drive notifications while in Mail
- **Localizable text** - All strings in one place per domain
- **Type-safe** - Full TypeScript coverage end-to-end
