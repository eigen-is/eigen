---
id: eigen-proof-of-concept
title: "Eigen: How Hard Can It Be to Build Your Own Workspace?"
summary: "After two months of development, I built a working proof of concept for a Google Workspace alternative where you control your own data. Here's what works and what's next."
---

Most European data lives on American servers, controlled by American companies. With the current mess in US politics and the power these tech companies have, that's become a problem. Someone should build a European alternative to Google Workspace.

So I wanted to see if I could do it myself. Not the entire thing - just enough to figure out if it's feasible. How hard can it be?

Turns out: not as hard as I expected. Two months later, I have a working proof of concept with mail, drive, docs, contacts, and kanban boards. All with real-time collaboration. You can try it at [eigen.is](https://eigen.is).

The name "Eigen" is Dutch/German for "own". That's what this is about: your own workspace, your own data, your own control.

## What Works Now

I have working implementations of several apps:

**eigen|mail>** - A webmail client that handles your inbox. You can read emails, send emails, organize folders, and search.

**eigen|drive>** - File storage and sharing. Upload files, create folders, share with other users, manage permissions. The basic Google Drive functionality.

**eigen|docs>** - A collaborative document editor. Multiple users can edit the same document simultaneously without conflicts. I use YJS for the operational transforms, which handles the real-time synchronization.

**eigen|contacts>** - Simple contact management. Add contacts, search, edit. Nothing fancy, but it works.

**eigen|stickies>** - Kanban boards like Trello. Create boards, add cards, drag them around. Multiple people can work on the same board at the same time, also using YJS for conflict-free collaboration.

## Technical Implementation

If you're less interested in the technical details, skip to the 'What's Next' section.

To prototype something quickly, I decided to actually use NPM packages and build on open-source libraries. This is something I normally *never* do. I prefer to write all code myself and reinvent every wheel. Even the few NPM packages I've published are completely dependency-free.

The stack is standard and modern (at least, that's what someone who knows these things told me): Bun for the server runtime, Elysia for server routing, Vite and React with TypeScript for the frontend, TanStack Router and TanStack Query for routing and data fetching. Tailwind CSS and shadcn/ui for the interface.

The interesting part is the architecture I accidentally ended up with. I started with a simple approach: each user gets their own directory. SQLite databases store metadata and structured data, actual content is stored as files. No shared databases, no complex central systems.

This was mostly laziness - it's the simplest thing that could possibly work. But it turned out to have some nice properties:

- Each user's data is completely isolated. No shared database means no way to accidentally access someone else's data.
- Backups are trivial - just copy a user's directory.
- Adding users doesn't affect existing ones. Easy to scale.
- Each user could potentially bring their own storage backend.

But it also creates problems:

- How do you share documents when each user's data is isolated?
- How do you enable real-time collaboration without a central database?
- How do you handle search across file-based data?

For real-time collaboration in docs and boards, I keep YJS documents in memory on the server during active sessions. YJS handles the operational transforms and synchronization via WebSockets. The document content gets saved to the file system periodically. When the session ends, the YJS document is removed from memory.

This is probably not how you'd design this if you were building it "properly". But it works.

## What's Next?

The proof of concept works. But getting from here to a production-ready system means solving some hard problems.

**Missing pieces:**
- End-to-end encryption for all user data
- Calendar with event management and sharing
- Spreadsheets and presentations
- Organization support (teams, shared resources)
- Protocol compatibility (IMAP, CalDAV, WebDAV) for standard clients
- Proper backup and migration tools

The interesting challenges are architectural. How do you handle organizational calendars when each user's data is isolated? How do shared documents work with end-to-end encryption? How do you implement collaborative spreadsheet formulas in this model?

These aren't theoretical questions. They're the core problems that need solving to make this work at scale.

**The per-user file architecture raises questions:**
- Can it scale? What are the performance limits?
- How do you implement encryption?
- Should workspace users map to system users for simplicity and security?
- What's the simplest backup strategy that actually works?

I'm not trying to defend the current implementation. I want to figure out if this approach can work, and if not, what the right approach is. The goal is a minimal, secure workspace - not Google Workspace with every feature.

To be clear: what exists now is maybe 5% of what needs to be built. Probably less. This needs more than one person. Realistically, probably 10+ person-years to build something production-ready. But I think a small focused team could do it by being ruthless about scope.

That's why I've decided to put more energy into this project and see if there's something real here. First step: open source the code so others can look at it, break it, and help figure out if this architecture actually works.

## Looking for Help

If you find these problems interesting and want to work on them, let's talk. If you're an organization that needs a European workspace solution and wants to test early versions, also let's talk. If you want to sponsor this financially, that would help too.

The project is at [eigen.is](https://eigen.is). Contact me at [reinder@eigen.is](mailto://reinder@eigen.is).
