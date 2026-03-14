# People App

> **TLDR**: Admin UI for org member + team management at `apps/people/`. Requires org role `admin` or `owner`. Uses
> better-auth client API for all operations.

## Pages

- **Members**: List, invite, change role, remove org members
- **Teams**: List, create, rename, delete teams
- **Team Detail**: List/add/remove team members, toggle team calendar on/off, set calendar member access
  (free-busy/read/write)

## Access

Route guard checks: authenticated + org role `admin` or `owner`. Visible via "People" in app switcher.

## API

Org/team management via `authClient.organization.*` (better-auth client). Team calendar settings via
`GET/PUT /calendar/team/:teamId/settings` (stored in `data/team/{teamId}/settings.json`).
