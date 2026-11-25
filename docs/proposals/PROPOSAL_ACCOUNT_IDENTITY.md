# Proposal: who a share names when an address changes hands

Notes to think with, not a decision. Raised in [issue #16](https://github.com/eigen-is/eigen/issues/16) (SSO via OIDC): should a share name a person by email or by user id?

**Status:** open. The ROADMAP row "A new account can take a deleted user's email address" tracks the gap.

## The problem

- A share names a person by email, and a team by id (`matchesACL`, `apps/api/src/lib/drive/acl.ts`). Calendar shares do the same (`CalendarShare.targetId`).
- Deleting a user leaves the entries in other homes on purpose, so a restored user gets their shares back.
- So a new account with a deleted user's address opens what the old one was shared. An address an admin changes leaves the old shares behind, waiting for the next holder of that address.
- The gap is there today (an admin can create such an account by hand). SSO creates accounts on first sign-in, with nobody in the loop, and organizations reuse addresses.

## Option A: keep email, add a date

- Each share entry gets the date it was added. Entries without one count as older than everything, so old files and backups stay readable and no home needs a migration.
- `users3.db` gets a list of addresses with the date each was released: on deleting a user and on an admin changing an address. Deleting a guest writes nothing, so a returning guest keeps their shares.
- An email entry counts only when it was added after its address was last released.
- The check runs at access time, so the creation paths that skip `user.create.before` (`guest-auth.ts`, `restoreAuthRows`) don't matter.
- Hash the addresses with a salt kept in `users3.db`, not the auth secret, so rotating the secret doesn't empty the list.
- Restoring a deleted user clears their row.
- Cost: one new table (a migration), a date on `DriveACL` and `CalendarShare`, one lookup when an entry's address matches the user.
- Accepted gap: a user whose address an admin changes loses the shares made to the old address.

## Option B: user ids for accounts

- A share to an existing account names its id. An invitation to an address with no account stays an email and is rewritten to the id when the account appears.
- Covers a reused address and an address change, with no gap.
- Guests still need email: the inactive-guest sweep deletes them, and a returning guest is a new id. So it is two rules, not one.
- The rewrite on signup crosses homes and can be lost, so an email entry still has to match as a fallback.
- Changes the stored ACL in every home's `drive.db` and calendar database, plus the share dialog (names for ids, also deleted ones), `getEffectiveMembers`, leaving a share, calendar share matching. Only cheap before 0.5.0.
- Works within one server only.

## Option C: accept the gap for now

- As ruled on 8 Nov 2026. Revisit when someone actually runs into it.
- Options A and B both add on later without breaking old files, though B gets costlier after 0.5.0.

## Why email as the identity

- It's what people type and see, and what calendar invites and mail already use.
- It's the only identity that would still mean something if Eigen servers ever share with each other. A local id doesn't.
- A guest proves the mailbox at every sign-in, so for a guest the address is the identity.

## What stays email whatever we pick

- Mail delivery: mail to a reused address should reach the new holder. The old mailbox goes with the deleted Home.
- Calendar attendees (the calendar standard uses addresses), comment assignments and mentions.

## Separate, for SSO itself

- An SSO sign-in with the address of an account that still exists can be linked to that account, which hands over the whole account, not just old shares.
- Already ruled: no linking to the owner or an admin.
- For other accounts: maybe link only when the provider's user id (`sub`) matches the one stored at first sign-in.
- This is SSO phase 1's question, whatever we pick above.
