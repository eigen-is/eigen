# Eigen

**Your personal workspace in the cloud. Simple and secure. You control your own data.**

A modern Google Workspace-like application suite providing integrated productivity and collaboration tools.

## Overview

Eigen is your minimal, secure workspace in the cloud. It includes mail, calendar, docs, and drive — everything you need, nothing you don't. It is a comprehensive workspace platform that includes:

- **Index**: Landing page and central hub
- **Mail**: Email client with mailbox management
- **Drive**: File storage and management system
- **Docs**: Document editing and collaboration
- **Calendar**: Schedule management
- **Contacts**: Contact management
- **Space**: Team collaboration workspace

## Project Structure

This project follows a monorepo structure, managed via Bun workspaces:

- `/apps`: Contains all applications
    - `/api-server`: Backend API server that powers all applications
    - `/index`, `/drive`, `/mail`, `/docs`, etc.: Frontend applications
- `/packages`: Shared libraries and components
    - `/ui`: Reusable UI components built with shadcn/ui
    - `/lib`: Shared business logic and utilities
    - `/config`: Shared configuration

## Technology Stack

- **Backend**: Bun + Elysia + Drizzle ORM
- **Frontend**: React + TypeScript + TanStack Router + TanStack Query
- **Styling**: Tailwind CSS + shadcn/ui
- **Authentication**: better-auth

## Getting Started

### Prerequisites

- Bun (latest version)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/<repository-owner>/eigen.git
cd eigen
```

2. Install dependencies (this will install dependencies for all workspaces):

```bash
bun install
```

### Running the Application

To run all applications simultaneously:

```bash
bun serve
```

To run specific applications:

```bash
# Run index app with API server
bun serve:index

# Run mail app with API server
bun serve:mail

# Run drive app with API server
bun serve:drive

# Run space app with API server
bun serve:space

# Run calendar app with API server
bun serve:calendar

# Run contacts app with API server
bun serve:contacts

# Run docs app with API server
bun serve:docs

# Run stickies app with API server
bun serve:stickies
```

### Building for Production

```bash
bun build
```

## Development

The project uses TypeScript for type safety and follows a modular architecture. Each application in the `/apps`
directory is self-contained but shares common components and utilities from the `/packages` directory.

### Adding Components

Components are built using shadcn/ui and Tailwind CSS. Shared components should be added to the `/packages/ui`
directory.

### API Development

API routes are organized by domain in the `/apps/api-server/src/routes` directory. Authentication is handled through
better-auth.

## License

[MIT License](LICENSE)
