# High Priority

[] Have another look at the clipboard system. Make it rock solid, cross app, cross tab, etc. Support copy and embedding
of SVG.

## Questions

[] Add hash to DrivePath?

# Med Priority

[] Make sure Maildir on server follows exactly the imap folder structure. Monitor changes and update accordingly.
[] POC: implement imap sync with maildir
[] POC: implement CalDAV sync with calendar
[] Implement import and export of common file formats (PDF, DOC, XLS, etc.)
[] Add eigen|vector> similar to https://excalidraw.com/ . This drawing should be an easy to re-use component, so it can
also be embedded in docs/slides and maybe mail?

## Questions

[] Where and how do we handle file formats queued / at different threads?

# Low Priority

[] Cleanup Fortune-sheet mess (`as any` x36, `@ts-ignore` x81, Chinese comments, CSS files)
[] Remove `"use client"` directives (~41 files, no-op in Vite)
[] Replace `interface` with `type` (~60 instances, project convention)
[] Extract duplicated collab utilities (`jsonToYType`, revision restore) to `packages/lib`

# Code Review Debt

Remaining items from the 2026-03 full-stack code review. See `codereviews/PROGRESS.md` for full history.

## Deferred (need design decisions)

[] C26: "This and following" delete is a no-op for recurrence exceptions (needs parent rrule fetch)
[] I43/I44: Calendar create/edit useEffect resets form when calendar list changes (need dep splitting)
[] I46: `moveEvent` deletes parent series when moving a single exception to another calendar
[] I16: Race condition in Home cleanup/recreation lifecycle (low practical risk, 5-min timeout)
[] I30: `getStorageFile` casts S3File to BunFile (S3 previews broken, needs common interface)

## Small remaining fixes

[] C28: Chat `handleSendMessage` — add try/catch + toast error feedback
[] I37: `useSSE` `isConnected` — change from stale ref snapshot to reactive useState
[] I50: Chat sidebar `window.location.href` → router navigate (avoid full page reload)
[] I54: Space profile editor — replace imperative fetch with query hook
[] I9: Mail HTML sanitization does not block CSS tracking (needs image proxy or "load remote content" toggle)
