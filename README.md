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

2. Visit `http://localhost:3011/setup` in your browser

3. Configure your instance:

   **Domain Configuration**
   - Enter your domain (e.g., `eigen.example.com` or `localhost` for development)

   **Storage Type**
   - `local-fullnames`: Files stored with original names (recommended for development)
   - `local-id`: Files stored by ID (better for production)
   - `s3`: Amazon S3 or compatible storage (for cloud deployment)

   If using S3, you'll need:
   - Bucket name
   - Region
   - Access Key ID
   - Secret Access Key
   - Endpoint URL (optional, for S3-compatible services like MinIO)

   **Admin Account**
   - Name
   - Email address
   - Password (minimum 8 characters)

4. After setup completes, you'll be redirected to sign in with your admin account

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
bun serve:admin
bun serve:contacts
bun serve:docs
bun serve:stickies
```

### Type Checking

```bash
# Run TypeScript type check across all packages
bun run typecheck
```

### Building for Production

```bash
bun build
```

## Docker Deployment

### Prerequisites

- Docker
- Docker Compose

### Local Docker Deployment

To run Eigen in Docker locally:

```bash
./deploy.sh --local
```

This will:

1. Build all frontend applications
2. Create Docker images for nginx (frontend) and API server
3. Start containers with Docker Compose
4. Make all apps available at `http://localhost/`

Access your applications:

- Home: http://localhost/
- Admin: http://localhost/admin
- Mail: http://localhost/mail
- Contacts: http://localhost/contacts
- Calendar: http://localhost/calendar
- Drive: http://localhost/drive
- Docs: http://localhost/docs
- Stickies: http://localhost/stickies
- Space: http://localhost/space

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

- [Contributing Guide](docs/CONTRIBUTING.md) - Development conventions and architecture patterns
- [Database Architecture](docs/DATABASE.md) - SQLite databases, migrations, and access patterns
- [Storage & Mount System](docs/STORAGE.md) - Storage backends and file management
- [SSE Architecture](docs/SSE.md) - Real-time updates and cache invalidation
- [Docker Deployment](docs/DOCKER.md) - Building and deploying with Docker

## License

[MIT License](LICENSE)
