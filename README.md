# Eigen

**Your personal workspace in the cloud. Simple and secure. You control your own data.**

A modern workspace platform providing integrated productivity and collaboration tools.

## Apps

- **Index**: Landing page and central hub
- **Mail**: Email client with mailbox management
- **Drive**: File storage and management
- **Docs**: Document editing and collaboration
- **Contacts**: Contact management
- **Calendar**: Calendar and scheduling
- **Space**: Team collaboration workspace
- **Stickies**: Kanban board
- **Chat**: Real-time chat with slash commands and whispers
- **Slides**: Collaborative presentation editor
- **Sheets**: Collaborative spreadsheet editor
- **People**: Organization and team management
- **Setup**: First-run setup wizard

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

### First Run Setup

On first run, Eigen requires initial configuration through a setup wizard:

1. Start the server:
   ```bash
   bun run serve
   ```

2. Visit `http://localhost:3011/setup` in your browser.

3. Configure your instance:
    - **Domain Configuration**: Enter your domain (e.g., `eigen.example.com` or `localhost` for development).
    - **Storage Type**:
        - `local-fullnames`: Files stored with original names (recommended for development).
        - `local-id`: Files stored by ID (better for production).
        - `s3`: Amazon S3 or compatible storage (for cloud deployment).
    - **Admin Account**: Set up your primary admin credentials.

4. After setup completes, you will be redirected to sign in with your admin account.

**Note:** Setup can only be completed once. The configuration is stored in the server data directory.

### Running Applications

```bash
# Run all applications
bun run serve

# Run specific app with API server
bun serve:index
bun serve:mail
bun serve:drive
bun serve:space
bun serve:people
bun serve:contacts
bun serve:docs
bun serve:stickies
bun serve:chat
bun serve:calendar
bun serve:slides
bun serve:sheets
```

### Type Checking and Building

```bash
# Run TypeScript type check across all packages
bun run typecheck

# Build for production
bun run build
```

## Docker Deployment

### Local Docker Deployment

To run Eigen in Docker locally:

```bash
./deploy.sh --local
```

This will build frontend applications, create Docker images, and start containers with Docker Compose. Apps will be
available at `http://localhost/`.

### Production Docker Deployment

For production deployment:

```bash
./deploy.sh
```

**Docker management:**

```bash
# View logs
docker-compose logs -f

# Stop containers
docker-compose down

# Restart containers
docker-compose restart
```

## Project Structure

- `/apps`: All applications (api + frontend apps)
- `/packages`: Shared code
    - `/ui`: Reusable UI components (shadcn/ui)
    - `/lib`: Shared business logic
- `/docs`: Architecture documentation

## Documentation

- [LLM Context](LLM.md) - Project context and architecture for LLMs
- [Contributing Guide](docs/CONTRIBUTING.md) - Development conventions and architecture patterns
- [Database Architecture](docs/DATABASE.md) - SQLite databases, migrations, and access patterns
- [Storage & Mount System](docs/STORAGE.md) - Storage backends and file management
- [SSE Architecture](docs/SSE.md) - Real-time updates and cache invalidation
- [Layout System](docs/LAYOUT.md) - Responsive layout system and components
- [Shared UI Components](docs/LAYOUT-SHARED-COMPONENTS.md) - UI component lookup reference
- [Organizations & Teams](docs/ORGANISATIONS-AND-TEAMS.md) - Organization and team management
- [Chat System](docs/CHAT.md) - Real-time chat with slash commands and collaboration
- [ACL System](docs/ACL.md) - Access control and sharing permissions
- [Clipboard System](docs/CLIPBOARD.md) - Inter-app copy-paste data preservation
- [Sheets App](docs/SHEETS.md) - Collaborative spreadsheet editor
- [Docker Deployment](docs/DOCKER.md) - Building and deploying with Docker

## License

[MIT License](LICENSE)
