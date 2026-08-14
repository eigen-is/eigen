---
id: eigen-six-months-later
title: "Eigen: Six Months Later"
description: "Six months after the proof of concept, Eigen grew from five basic apps to a full workspace with calendar, spreadsheets, slides, chat, IMAP and CalDAV. Now I need testers, and people who can help figure out what's next."
---

Six months ago I [wrote about Eigen](https://eigen.is/blog/eigen-proof-of-concept): a European Google Workspace alternative where you own your data. Back then I had five basic apps, built in two months of spare time. Mail, drive, docs, contacts and kanban boards. Minimal, but functional.

I kept building. Here is where it stands.

## What's new

Five new apps joined the workspace:

- **eigen|calendar>**: recurring events, team calendars, invitations with RSVP. Supports CalDAV, so you can use it
  with Apple Calendar, Thunderbird or any standard client. Calendar invitations work over email too (iMIP), so inviting
  external people should work.
- **eigen|sheets>**: collaborative spreadsheets. Real-time editing with Yjs, same as docs.
- **eigen|slides>**: collaborative presentations. A slide editor with export to HTML and PDF. You can present
  directly from the browser.
- **eigen|chat>**: real-time chat inspired by MUDs. Attachments, mentions and an unreasonable number of slash commands.
- **eigen|admin>**: server administration with a setup wizard, team management, waitlist and
  invite-based signup.

<media-grid columns="3">
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/mail.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_mail.webp"
    type="image" 
    caption="eigen|mail>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/calendar.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_calendar.webp"
    type="image" 
    caption="eigen|calendar>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/drive.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_drive.webp"
    type="image" 
    caption="eigen|drive>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/contacts.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_contacts.webp"
    type="image" 
    caption="eigen|contacts>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/docs.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_docs.webp"
    type="image" 
    caption="eigen|docs>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/stickies.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_stickies.webp"
    type="image" 
    caption="eigen|stickies>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/sheets.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_sheets.webp"
    type="image" 
    caption="eigen|sheets>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/slides.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_slides.webp"
    type="image" 
    caption="eigen|slides>" />
  <media 
    src="/data/blog/media/2026-04-11-eigen-six-months-later/chat.webp" 
    thumb="/data/blog/media/2026-04-11-eigen-six-months-later/thumb_chat.webp"
    type="image" 
    caption="eigen|chat>" />
</media-grid>

Beyond new apps, a lot happened under the hood:

- **IMAP support**: you can now use Eigen mail with Thunderbird, Apple Mail or any IMAP client.
- **Document export**: docs export to DOCX, PDF and HTML. Slides export to PDF and HTML.
- **Teams**: shared drives and team calendars. Share documents with your teams.
- **Notifications**: unread indicators, deep linking to comments, activity badges.
- **S3 storage mounts**: file storage can now be backed by S3-compatible services, so you can use external
  object storage instead of (or alongside) local disk.
- **Scaling**: started with multi-server scaling, not fully implemented yet.

The original architecture held up pretty well. Per-user SQLite databases, file-based storage, Yjs for real-time collaboration.
Nothing fundamental broke. The tricky parts turned out to be cross-user operations. The relay layer that solves this is also the foundation for horizontal
scaling: since each user already has all their data in one separate directory, you can shard by user across multiple servers.

## What's missing

A lot. Some of the bigger gaps:

- Import and export to common formats. There is a proof of concept for export of docs and slides, but importing Google Docs, Office files or
  migrating data from other services is not there yet.
- Charts and graphs in spreadsheets, docs and slides.
- A drawing and diagramming app (eigen|vector> ?).
- Search across all your data.
- It works on mobile, but it's not optimized.

## Try it

Despite these gaps, I think that the core engine is stable, so it can (and should) be tested.

**I'm looking for people who want to try Eigen.** Not a launch, not a beta. A few weeks of real use by real people,
so I can find bugs, fix what's broken and figure out what to build next. If you want to try it out, please sign up at
[eigen.is](https://eigen.is) or reach me at [reinder@eigen.is](mailto:reinder@eigen.is).

## What's next

During this testing period, I need to figure out the right structure for taking Eigen further. There are a few
directions:

- **Open source**: release the code so anyone can self-host Eigen as-is.
- **Find a home**: an organization, foundation or company that wants to adopt Eigen.
- **Build a team**: find people who want to develop it further together.

These are options I came up with myself, but I'm really looking for the right people to talk to.
If you know someone who has experience growing open-source or public-interest tech projects, or works at a foundation,
institution or company that might want to adopt something like Eigen: please put us in touch. I'm not looking for
developers right now. I'm looking for people who can help figure out the right home for this project.

And just to be clear: I'm not attached to keeping ownership and I'm not looking for money. I want Eigen to exist and
to work.

[reinder@eigen.is](mailto:reinder@eigen.is) | [reindernijhoff.net](https://reindernijhoff.net/)
