---
id: eigen-proof-of-concept
title: "Eigen: A Proof of Concept for a Personal Workspace"
summary: "After two months of development, I built a working proof of concept for a Google Workspace alternative where you control your own data. Here's what works and what's next."
---

I spent the last two months building Eigen, a proof of concept for a personal workspace in the cloud. Think Google Workspace, but where you actually control your data. You can try it at [eigen.is](https://eigen.is).

The name "eigen" is Dutch/German for "own". That's the whole idea: your own workspace, your own data, your own control.

## What Works Now

I have working implementations of several apps:

**eigen|mail>** - A webmail client that handles your inbox. You can read emails, send emails, organize folders, and search.

**eigen|drive>** - File storage and sharing. Upload files, create folders, share with other users, manage permissions. The basic Google Drive functionality.

**eigen|docs>** - A collaborative document editor. Multiple users can edit the same document simultaneously without conflicts. I use YJS for the operational transforms, which handles the real-time synchronization.

**eigen|contacts>** - Simple contact management. Add contacts, search, edit. Nothing fancy, but it works.

**eigen|stickies>** - Kanban boards like Trello. Create boards, add cards, drag them around. Multiple people can work on the same board at the same time, also using YJS for conflict-free collaboration.

You can see everything at [eigen.is](https://eigen.is). Request an account and try it.

## Technical Implementation

The stack is straightforward: Bun for the runtime, Elysia for the web framework, React with TypeScript for the frontend, TanStack Router and TanStack Query for routing and data fetching. I use Tailwind CSS and shadcn/ui for the interface.

The interesting part is the architecture. I made a decision early on: all user data (except login credentials) is stored file-based, per user. Everything lives in the user's own directory. SQLite databases store metadata and structured data, while actual content is stored as files. No shared databases, no complex central systems.

This creates some technical challenges:
- How do you share documents when each user's data is completely isolated?
- How do you enable real-time collaboration without a central database?
- How do you handle search across file-based data?

But these constraints bring benefits:
- Natural data isolation and privacy
- Simple backups - just copy a user's directory
- Easy to scale - adding users doesn't affect existing ones
- Each user could potentially use different storage backends

For real-time collaboration in documents and boards, I keep YJS documents in memory on the server during active sessions. When users edit, YJS handles the operational transforms and synchronization via WebSockets. The document content gets encrypted and saved to the file system periodically. When the session ends, the YJS document is removed from memory.

I wrote detailed documentation about the encryption approach in [ENCRYPTION.md](https://github.com/reindernijhoff/eigen/blob/main/apps/api-server/ENCRYPTION.md) and the scalability architecture in [SCALABILITY.md](https://github.com/reindernijhoff/eigen/blob/main/apps/api-server/SCALABILITY.md). The encryption part isn't implemented yet - that's future work. But the architecture is designed for it.

## Current State

This is a proof of concept. It demonstrates that the core ideas work: per-user file storage, real-time collaboration, integrated apps. But it's maybe 5% of what a production system needs.

What's missing:
- End-to-end encryption for all user data
- Calendar with proper event management
- Spreadsheets and presentations
- Organization support (teams, shared resources)
- Protocol compatibility (IMAP, CalDAV, WebDAV) so you can use standard clients
- Proper backup and migration tools
- A lot of polish and edge case handling

The current implementation works for demonstrating the concept. It's not ready for production use.

## Why Build This?

I wanted to see if you could build a workspace suite with a fundamentally different architecture. The per-user file-based approach is unusual. Most systems use shared databases and centralized storage. I wanted to explore what changes when you isolate user data completely and design around that constraint.

Also, Europe needs its own digital infrastructure. Right now, most European data lives on American servers, controlled by American companies. The EU pushes for digital sovereignty, but we need actual working alternatives. Eigen is one attempt at that.

## What's Next?

I built a working proof of concept in two months. The core architecture works. Real-time collaboration works. The integrated apps work together.

But there's a lot more to figure out. How do you handle organizational calendars when each user has isolated data? How do you implement spreadsheet formulas in a collaborative environment? How do you make protocol compatibility work with end-to-end encryption? These are solvable problems, but they need more thought and more time.

I want to continue developing Eigen, but I realize this is bigger than a hobby project. To build a genuine alternative to Google Workspace or Microsoft 365, you need a complete office suite, full encryption, organizational support, protocol compatibility - probably 10+ person-years of focused development.

## Looking for Collaboration

I'm looking for people who want to help:

**Developers** - If you find the technical challenges interesting (per-user isolation, real-time collaboration, encryption architecture), I'd like to work together.

**Organizations** - If you need a European workspace solution and want to test early versions, let's talk. Your feedback would be valuable.

**Sponsors** - If you see the value in European digital sovereignty and want to support development financially, that would help.

**Anyone interested** - If you just want to follow along, try the demo, or provide feedback, that's also useful.

The project is at [eigen.is](https://eigen.is). You can contact me at [your email here] or follow the development on GitHub (link coming soon).

This is a proof of concept, not a finished product. But it shows what's possible when you design around different constraints. I think there's something here worth developing further.
