---
id: eigen-proof-of-concept
title: "Eigen: How Hard Can It Be to Build Your Own Workspace?"
summary: "After two months of development, I built a working proof of concept for a Google Workspace alternative where you control your own data. Here's what works and what's next."
---

Most European data lives on American servers, controlled by American companies. With the current mess in US politics and the power these tech companies have, that's become a problem. Someone should build a European alternative to Google Workspace.

So I started wondering: how hard could it be to build my own Google Workspace?

Turns out, not that hard. At least to get a basic version running. After about two months of development in my spare time, I had a working proof of concept: mail, drive, docs, contacts, and kanban boards. It even does real-time collaboration. You can try it at eigen.is.

The name "Eigen" is Dutch/German for "own," which turned out to describe the whole idea pretty well.

## Apps

The basics work:

**eigen|mail>** - a simple webmail client. You can read and send messages, create folders, and search.

**eigen|drive>** - file storage and sharing. Upload files, create folders, share with others.

**eigen|docs>** - collaborative text editing using Yjs. Multiple users can edit the same document without conflicts.

**eigen|contacts>** - basic contact management.

**eigen|stickies>** - kanban boards, like Trello. You can move cards around and collaborate in real time.

It’s all minimal, but functional enough to feel like a small ecosystem.

## Under the hood

To prototype something quickly, I decided to actually use NPM packages and build on open-source libraries. This is something I normally avoid. Usually, I end up writing all code myself and reinventing every wheel. Even the few NPM packages I've published are dependency-free.

The stack is standard and modern (at least, that’s what someone who knows these things told me): Bun for the server runtime, Elysia for routing, Vite and React with TypeScript for the frontend, TanStack Router and TanStack Query for routing and data fetching, Tailwind CSS and shadcn/ui for the interface.

The interesting part is the architecture I accidentally ended up with. I started with a simple approach: each user gets their own directory. SQLite databases store metadata and structured data, actual content is stored as files. No shared databases, no complex central systems.

I did it that way because it was the simplest thing that could possibly work.
But it has some nice properties:

- Each user's data is completely isolated. No shared database means no way to accidentally access someone else's data.
- Backups are trivial: just copy a user's directory.
- Adding users doesn't affect existing ones. Easy to scale.
- Each user could potentially bring their own storage backend.

Of course, it also creates a few interesting problems:

- How do you share documents when each user's data is isolated?
- How do you enable real-time collaboration without a central database?
- How do you handle search across file-based data?

For real-time collaboration (in docs and stickies), I keep Yjs documents in memory on the server while they’re active. They sync over WebSockets, and periodically the content is written to disk. When everyone closes the doc, it disappears from memory.

## What's Next?

The proof of concept works. But getting from here to a production-ready system means solving some hard problems.

**Missing pieces:**
- End-to-end encryption
- Calendar
- Spreadsheets and presentations
- Organization support (teams, shared resources)
- Protocol compatibility (IMAP, CalDAV, WebDAV) for standard clients
- Backup and migration tools

The interesting challenges are architectural. How do you handle organizational calendars when each user's data is isolated? How do shared documents work with end-to-end encryption? How do you implement collaborative spreadsheet formulas in this model?

These aren't theoretical questions. They're the core problems that need solving to make this work at scale.

**The per-user file architecture raises questions:**
- Can it scale? What are the performance limits?
- How do you implement encryption?
- Should workspace users map to system users for simplicity and security?
- What's the simplest backup strategy that actually works?

I'm not trying to defend the current implementation. I want to figure out if this approach can work, and if not, what the right approach is. The goal isn’t to clone Google Workspace, but to find out how far you can get with something smaller, simpler, and actually yours.

To be clear, what exists now is maybe five percent of what needs to be built. Probably less. This needs more than one person. Realistically, ten or more person-years to build something production-ready. But I think a small focused team could do it by being ruthless about scope.

So I’m going to keep pushing it a bit further and see how far this idea can go before it breaks. First step: open source the code so others can look at it, break it, and help figure out if this architecture actually works.

## Looking for Help

If you find these problems interesting and want to work on them, let's talk. If you're an organization that needs a European workspace solution and wants to test early versions, also let's talk. If you want to sponsor this financially, that would help too.

The project is at [eigen.is](https://eigen.is). Contact me at [reinder@eigen.is](mailto://reinder@eigen.is).
