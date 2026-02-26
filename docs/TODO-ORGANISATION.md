# TODO: People App (User & Team Management)

> **Status**: Not yet implemented. See `docs/ORGANISATIONS-AND-TEAMS.md` for what is already built (org setup, teams, team drives, team ACL).

---

## Overview

A new frontend app (`apps/people/`) accessible to users with org role `admin` or `owner`. This is the UI for managing the organization's members and teams. It lives alongside the existing `apps/admin/` app (which handles system-level settings like storage, domain, etc.).

**Why a separate app?** The admin app (`apps/admin/`) is for system `admin` only (server config, storage, setup). People management is an org-level concern — org admins should access it without needing system admin rights. Keeping them separate follows the existing app-per-domain pattern.

---

## Pages

### People > Members
- List all org members (name, email, org role, system role, joined date)
- Change a member's org role (`member` ↔ `admin`). Only `owner` can promote to `admin`.
- Remove a member from the org (does NOT delete the user account — just removes org membership)
- Invite new members by email (uses better-auth `invitation` flow)
- Filter/search by name or email

### People > Teams
- List all teams in the org
- Create new team (name)
- Edit team (rename)
- Delete team (removes team, does NOT affect members' accounts)
- View team members

### People > Team Detail (People > Teams > {teamName})
- List team members (name, email, team role)
- Add members to team (autocomplete from org members)
- Remove members from team
- Change team role (`member` ↔ `owner`)

---

## API Routes

Most of this is handled by better-auth's client API (`authClient.organization.*`). Custom routes needed:

```typescript
// apps/api/src/routes/people.ts (or extend admin.ts)
// Middleware: require org admin/owner role

GET    /people/members              → list org members (wraps better-auth)
PATCH  /people/members/:userId/role → change org role
DELETE /people/members/:userId      → remove from org
POST   /people/invite               → send invitation

GET    /people/teams                → list teams
POST   /people/teams                → create team
PATCH  /people/teams/:teamId        → rename team
DELETE /people/teams/:teamId        → delete team

GET    /people/teams/:teamId/members    → list team members
POST   /people/teams/:teamId/members    → add member to team
DELETE /people/teams/:teamId/members/:userId → remove from team
PATCH  /people/teams/:teamId/members/:userId/role → change team role
```

Alternatively, if better-auth's client API covers all of this, the frontend can call `authClient.organization.*` directly and skip custom routes. Evaluate during implementation — better-auth may handle everything except the role guard middleware.

---

## Access Control

The People app route guard checks:
1. User is authenticated (session)
2. User has org role `admin` or `owner` (query `member` table for user's role in active org)

```typescript
// In apps/people/ route guard or API middleware:
const membership = await getMemberByUserId(orgId, user.id);
if (!membership || !['admin', 'owner'].includes(membership.role)) {
    throw new ApiError(403, 'Org admin access required');
}
```

---

## Navigation

Add a "People" link in the app switcher (the grid icon in the top bar). Only visible to users with org `admin`/`owner` role. The app switcher already conditionally shows "Admin" — same pattern.

---

## Implementation Tasks

| # | Task | Files |
|---|------|-------|
| 1 | Scaffold `apps/people/` app (Vite + React + TanStack Router, same pattern as `apps/admin/`) | `apps/people/` |
| 2 | Add route guard: require org `admin` or `owner` role | `apps/people/src/routes/_auth.tsx` |
| 3 | Members list page: list, search, filter org members | `apps/people/src/routes/_auth.members.tsx` |
| 4 | Member role editing: change org role, remove member | `apps/people/src/routes/_auth.members.tsx` |
| 5 | Invite member page/dialog | `apps/people/src/components/invite-dialog.tsx` |
| 6 | Teams list page: list, create, rename, delete teams | `apps/people/src/routes/_auth.teams.tsx` |
| 7 | Team detail page: list members, add/remove, change team role | `apps/people/src/routes/_auth.teams.$teamId.tsx` |
| 8 | Add People API routes (or use better-auth client API directly) | `apps/api/src/routes/people.ts` |
| 9 | Add "People" to app switcher (conditionally, for org admin/owner) | `packages/ui/src/components/layout/` |
