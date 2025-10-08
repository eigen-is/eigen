---
id: eigen-proof-of-concept
title: "Eigen: Building a Workspace"
summary: "After two months of development, I built a working proof of concept for a Google Workspace alternative where you control your own data. Here's what works and what's next."
---

Last spring I started wondering: how hard would it be to build my own Google Workspace? Given the situation in the USA and the power large tech companies hold, a European alternative feels needed. Building a workspace yourself sounds impossible, but you only know for sure if you have tried.

Surprisingly, after only two months of spare-time development, I had a working proof of concept. Mail, drive, docs, contacts and kanban boards are in place with real time collaboration. You can try it at eigen.is.

The name Eigen is Dutch and German for own, which turned out to describe the whole idea well.

## Apps

The basics work:

- **eigen|mail>**: a simple webmail client. You can read and send messages.
- **eigen|drive>**: file storage and sharing. Upload files, create folders, share with others.
- **eigen|docs>**: collaborative text editing using Yjs. Multiple users can edit the same document without conflicts.
- **eigen|contacts>**: basic contact management.
- **eigen|stickies>**: kanban boards like Trello. You can move cards around and collaborate in real time.

It’s all minimal, but functional enough to feel like a small ecosystem.

## Under the hood

To prototype something quickly, I decided to use NPM packages and build on open source libraries. This is something I normally avoid. I often end up writing all code myself and reinventing wheels. Even the few NPM packages I published are dependency free.

The stack is standard and modern (at least, that’s what someone who knows these things told me): Bun for the server runtime, Elysia for routing, Vite and React with TypeScript for the frontend, TanStack Router and TanStack Query for routing and data fetching, Tailwind CSS and shadcn/ui for the interface.

The interesting part is the architecture I accidentally ended up with. I started with a simple approach: each user gets their own directory. SQLite databases store metadata and structured data, actual content is stored as files. No shared databases, no complex central systems.

I did it that way because it was the simplest thing that could work.

But it has some nice properties:

- Each user's data is completely isolated. No shared database means no way to accidentally access someone else's data.
- Backups are trivial: just copy a user's directory.
- Adding users doesn't affect existing ones. Easy to scale.
- Each user could potentially bring their own storage backend.

Of course, it also creates a few interesting problems:

- How do you share documents when each user's data is isolated?
- How do you enable real-time collaboration without a central database?
- How do you handle search across file-based data?

For real time collaboration in docs and stickies, the server keeps Yjs documents in memory while they are active. They sync over WebSockets and periodically write to disk. When everyone closes the doc, it disappears from memory.

## What's Next?

After two months of spare time development, much more works than I expected. That makes me excited to keep going and to see how far this can go. You never know if it will really work or become truly useful, but I would like to find out.

Reality check: I have built only a very small part of a minimum viable product. Probably less than five percent of what needs to be built, and it will take many years of work to reach production readiness.

Missing pieces:
- End-to-end encryption
- Calendar
- Spreadsheets and presentations
- Organization support (teams, shared resources)
- Protocol compatibility (IMAP, CalDAV, WebDAV) for standard clients
- Backup and migration tools

Open questions in the per user file architecture:

- Can it scale? What are the performance limits?
- How do you implement encryption with this layout?
- Should workspace users map to system users for simplicity and security?
- What's the simplest backup strategy that actually works?

Next steps:

- Keep pushing and see where it breaks
- Open source the code so others can look at it, try to break it and help validate the architecture
- Collect feedback, refine the scope and decide what to build first

## Looking for input and support

I would love input from others. The current structure is not leading and not a requirement. I want it to work. The aim is a simple and safe workspace where you own your data.

If you want to try early versions, contribute or sponsor, let me know. The project is at eigen.is. You can reach me at [reinder@eigen.is](mailto:reinder@eigen.is).
