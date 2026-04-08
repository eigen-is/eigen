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

## "All Contacts" as Universal Suggestion Source

Every autosuggest in the app should use the same merged list: `deduplicate(myTeamMembers + myPersonalContacts)`,
keyed by email. This is implemented as `useAllContacts()` in `packages/lib/src/core/contacts/hooks/`. See the
autosuggest implementation for details.

## Future: Federation

Eigen instances could eventually participate in a federated network. The contacts app becomes the bridge to
users on other instances — personal contacts with external eigen.is addresses.
