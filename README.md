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
   bun serve
   ```

2. Visit `http://localhost:3010/admin` to create your first admin user

### Running Applications

```bash
# Run all applications
bun serve

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

- `/apps`: All applications (api-server + frontend apps)
- `/packages`: Shared code
  - `/ui`: Reusable UI components (shadcn/ui)
  - `/lib`: Shared business logic
  - `/config`: Shared configuration

## License

[MIT License](LICENSE)
