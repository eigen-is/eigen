---
id: eigen-six-months-later
title: "Eigen: Six Months Later"
summary: "Six months after the proof of concept, Eigen grew from five basic apps to a full workspace with calendar, spreadsheets, slides, chat, IMAP and CalDAV. Now I need testers, and people who can help figure out what's next."
---

Six months ago I [wrote about Eigen](https://eigen.is/blog/eigen-proof-of-concept): a European Google Workspace alternative where you
own your data. Back then I had five basic apps, built in two months of spare time. Mail, drive, docs, contacts and kanban
boards. Minimal, but functional.

I kept building. Here's where it stands.

## What's new

Five new apps joined the workspace:

- **eigen|calendar>**: recurring events, team calendars, invitations with RSVP. Supports CalDAV, so you can use it
  with Apple Calendar, Thunderbird or any standard client. Calendar invitations work over email too (iMIP), so inviting
  external people just works.
- **eigen|sheets>**: collaborative spreadsheets. Real-time editing with Yjs, same as docs.
- **eigen|slides>**: collaborative presentations. A canvas-based editor with export to HTML and PDF. You can present
  directly from the browser.
- **eigen|chat>**: real-time chat inspired by MUDs. Emotes, mentions and an unreasonable number of slash commands.
- **eigen|admin>**: server administration with a setup wizard, team and organization management, waitlist and
  invite-based signup.

Beyond new apps, a lot happened under the hood:

- **IMAP support**: you can now use Eigen mail with Thunderbird, Apple Mail or any IMAP client. Autodiscovery is in
  place so setup is straightforward.
- **Document export**: docs export to DOCX, PDF and HTML. Slides export to PDF and HTML.
- **Teams**: shared drives, team calendars, and a share dialog that knows about your team members.
- **Notifications**: unread indicators, deep linking to comments, activity badges.
- **Scaling**: groundwork for multi-process scaling, not fully implemented yet.

The original architecture held up well. Per-user SQLite databases, file-based storage, Yjs for real-time collaboration.
Nothing fundamental broke. The tricky parts turned out to be cross-user operations: sharing a drive item, sending a
calendar invite, relaying a chat message. The relay layer that solves this is also the foundation for horizontal
scaling: since each user already has their own database, you can shard by user across multiple servers.

## What's missing

A lot. Some of the bigger gaps:

- Import and export to common formats. You can export docs and slides, but importing Google Docs, Office files or
  migrating data from other services is not there yet.
- Charts and graphs in spreadsheets, docs and slides.
- A drawing and diagramming app (eigen|vector> ?). Proposed, not built.
- Search across all user data.
- Mobile experience. It works on mobile, but it's not optimized.

## Try it

Despite these gaps, the core engine is highly stable, and I need to stress-test it in the wild.

**I'm looking for people who want to try Eigen.** Not a launch, not a beta. A few weeks of real use by real people,
so I can find bugs, fix what's broken and figure out what to build next. If that sounds interesting, sign up at
[eigen.is](https://eigen.is) or reach me at [reinder@eigen.is](mailto:reinder@eigen.is).

## What's next

After this testing period, I need to figure out the right structure for taking Eigen further. There are a few
directions:

- **Open source**: release the code so anyone can self-host Eigen as-is.
- **Find a home**: an organization, foundation or company that wants to adopt Eigen.
- **Build a team**: find people who want to develop it further together.

I have options. I'm looking for the right people to talk to.
If you know someone who has experience growing open-source or public-interest tech projects, or works at a foundation,
institution or company that might want to adopt something like Eigen: please put us in touch. I'm not looking for
developers right now. I'm looking for people who can help figure out the right home for this project.

And just to be clear: I'm not attached to keeping ownership and I'm not looking for money. I want Eigen to exist and
to work.

[reinder@eigen.is](mailto:reinder@eigen.is) · [Bluesky](https://bsky.app/profile/reindernijhoff.net) · [reindernijjhoff.net](https://reindernijhoff.net/)
