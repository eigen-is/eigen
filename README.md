# Eigen

**Your personal workspace in the cloud. Simple and secure. You control your own data.**

A modern workspace platform providing integrated productivity and collaboration tools.

## Apps

- **Index**: Landing page and central hub
- **Mail**: Email client with mailbox management
- **Drive**: File storage and management
- **Docs**: Document editing and collaboration
- **Contacts**: Contact management
- **Space**: Team collaboration workspace
- **Stickies**: Kanban board

## Technology Stack

- **Backend**: Bun + Elysia + Drizzle ORM + SQLite
- **Frontend**: React + TypeScript + TanStack Router
- **Styling**: Tailwind CSS + shadcn/ui
- **Authentication**: better-auth

## Getting Started

### Prerequisites

- Bun (latest version)

### Installation

```bash
git clone https://github.com/eigen-foundation/eigen.git
cd eigen
bun install
```

### Initial Setup

On first run, the system will create the database and prompt you to create an admin user:

1. Start the server:
   ```bash
   bun serve:index
   ```

2. Visit `http://localhost:8000/setup` to create your first admin user

### Running Applications

```bash
# Run all applications
bun serve

# Run specific app with API server
bun serve:index
bun serve:mail
bun serve:drive
bun serve:space
bun serve:calendar
bun serve:contacts
bun serve:docs
bun serve:stickies
```

### Building for Production

```bash
bun build
```

## Project Structure

- `/apps`: All applications (api-server + frontend apps)
- `/packages`: Shared code
  - `/ui`: Reusable UI components (shadcn/ui)
  - `/lib`: Shared business logic
  - `/config`: Shared configuration

## License

[MIT License](LICENSE)
