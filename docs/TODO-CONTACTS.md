# Contacts App Improvements

> **TLDR**: The contacts app shows personal contacts and team members. Team members appear as read-only entries
> in the sidebar. Autosuggest merges both sources. Future work: merge/deduplicate team members with personal
> contacts, "Add to contacts" for team-only entries.

## Sidebar (implemented)

| Section | What it shows |
|---------|--------------|
| **My Contacts** (default) | Personal contacts you've created |
| *Team A, Team B, ...* | Members of each team you belong to (read-only) |
| Labels | Personal contacts filtered by label |

Team items use `UserAvatar` with `teamOwnerId(team.id)` for the icon, matching the Drive sidebar pattern.
Data comes from `useMyTeams()` — no new API needed.

## Team Member Views (implemented)

- **List**: Uses the same alphabetical grouping and `eigen-list-item` row styling as contacts. Supports search
  via the shared toolbar. No drag-drop, no label assignment, no multi-select.
- **Detail**: Read-only view with avatar, name, email. No edit/delete/label actions. Uses the same layout as
  `ContactDetail` but simplified.
- **Routing**: `filterType="team"`, `filterId={teamId}` extends the existing `filterType/filterId` pattern.

## Autosuggest (implemented)

`useContactSuggestions` in `packages/ui/src/components/layout/contacts/use-contact-suggestions.ts` merges
team members (from `useMyTeams()`) with personal contacts, deduplicated by email. Team members appear first.
An `excludeEmails` prop filters out the current user and already-added entries in share dialogs.

## Future: Merge/Deduplicate

When a team member also exists as a personal contact (matched by email):

- **Name/avatar**: team member wins (authoritative — they set it themselves)
- **Extra fields** (phone, notes, labels, birthday): personal contact data enriches the entry
- Team-only entries show a lean card with "Add to contacts" option
- Personal-only entries show as they do today

## Future: Federation

Eigen instances could eventually participate in a federated network. The contacts app becomes the bridge to
users on other instances — personal contacts with external eigen.is addresses.
