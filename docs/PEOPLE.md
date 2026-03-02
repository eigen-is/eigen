# People App (User & Team Management)

## Overview

The People frontend app (`apps/people/`) provides a UI for users with org role `admin` or `owner` to manage organization
members and teams. It lives alongside the `apps/admin/` app (which handles system-level settings).

**Why a separate app?** System admins (`apps/admin/`) handle server config/storage. People management is an org-level
concern. Keeping them separate follows the app-per-domain pattern.

## Pages

### People > Members

- List org members (name, email, org role, system role, joined date).
- Change member's org role (`member` ↔ `admin`). Only `owner` can promote to `admin`.
- Remove member from org (does NOT delete user account).
- Invite new members by email (via better-auth `invitation` flow).
- Filter/search by name or email.

### People > Teams

- List all teams in the org.
- Create, rename, delete teams.
- Delete team does NOT affect members' accounts.
- View team members.

### People > Team Detail

- List team members (name, email, team role).
- Add members to team (autocomplete from org members).
- Remove members from team.
- Change team role (`member` ↔ `owner`).

## API Routes

Mostly handled by better-auth client API (`authClient.organization.*`).

## Access Control

The People app route guard checks:

1. User is authenticated.
2. User has org role `admin` or `owner` (via active org membership).

## Navigation

Accessible via the "People" link in the app switcher. Visible only to org `admin`/`owner`.
