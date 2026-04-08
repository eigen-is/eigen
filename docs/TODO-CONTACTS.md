# Contacts App Improvements

> **TLDR**: The contacts app currently only shows personal contacts. Future work: show team members alongside
> personal contacts, merge/deduplicate by email, and restructure the sidebar to reflect this.

## Contacts App Sidebar Restructure

Current sidebar shows only labels. Proposed structure:

| Section | What it shows |
|---------|--------------|
| **All contacts** (default) | Deduplicated team members + personal contacts |
| **Own contacts** | Only personal contacts you've created |
| *Team A, Team B, ...* | Members of each team you belong to |
| Labels (existing) | Personal contacts filtered by label |

## Merge Logic

When a team member also exists as a personal contact (matched by email):

- **Name/avatar**: team member wins (authoritative — they set it themselves)
- **Extra fields** (phone, notes, labels, birthday): personal contact data enriches the entry
- Team-only entries show a lean card with "Add to contacts" option
- Personal-only entries show as they do today

## Autosuggest (implemented)

`useContactSuggestions` in `packages/ui/src/components/layout/contacts/use-contact-suggestions.ts` already
merges team members (from `useMyTeams()`) with personal contacts, deduplicated by email. Team members appear
first. An `excludeEmails` prop filters out the current user and already-added entries in share dialogs.

The contacts app sidebar restructure (above) would use `useMyTeams()` directly for per-team member lists.

## Future: Federation

Eigen instances could eventually participate in a federated network. The contacts app becomes the bridge to
users on other instances — personal contacts with external eigen.is addresses.
