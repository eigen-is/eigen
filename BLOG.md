# Eigen: Building a European Alternative to Google Workspace

> **TL;DR**: Built a proof of concept for a Google Workspace alternative. Live demo at eigen.is. Real-time collaboration, file sharing, and multiple integrated apps work. Much more needed to make it production-ready and complete. Looking for contributors. Going open source soon.

## What is Eigen?

Eigen is a workspace suite like Google Workspace or Microsoft 365, but where you control your data. It's a collection of productivity apps (mail, drive, docs, calendar, contacts, and more) that work together.

**Already working**: minimal implementations of Mail, Drive, Docs (with real-time collaboration), Contacts, and Kanban boards - all built as a proof of concept.

The difference: with Eigen you can choose where your data lives*. Use the public service at eigen.is, optionally store your data on your own cloud storage, or self-host your own instance entirely. Your choice.

The name "eigen" means "own" in Dutch/German. It's about owning your digital workspace.

*Currently Eigen runs as a hosted service. Own cloud storage and self-hosting options are planned features.

## Why Build Another Workspace Suite?

Simple: Europe needs its own cloud services. Right now, most European data is stored on American servers, controlled by American companies. The EU is actively pushing for digital sovereignty - the ability to control our own digital infrastructure and data. 

With Eigen, you get:
- **Full data control** - Your data stays where you put it
- **Privacy by design** - Zero-knowledge architecture (the server can't read your data)
- **No vendor lock-in** - Open source, self-hostable
- **European values** - Built with GDPR and privacy in mind

I believe organizations and individuals should have a real alternative to Big Tech solutions. One that respects privacy and gives complete control back to users.

## Current Status: Six Weeks of Proof of Concept

I've been working on this for six weeks in my free time. The proof of concept is live - and it works!

### eigen|mail> - Email Client
A full webmail client with:
- Inbox management
- Send/receive emails
- Folder organization  
- Search functionality

*[Screenshot placeholder: Mail interface showing inbox, folders, and email composition]*

### eigen|drive> - File Storage
A complete file management system:
- Upload/download files
- Create folders
- Share files with other users
- Permission management
- File preview

*[Screenshot placeholder: Drive interface with file browser and sharing dialog]*

### eigen|docs> - Document Editor  
Simple but powerful document editing:
- Real-time collaborative editing (multiple users can edit simultaneously)
- Conflict-free merging using YJS
- Document sharing with permissions
- Auto-save functionality

*[Video placeholder: Two users editing the same document in real-time]*

### eigen|contacts> - Contact Management
Basic contact list functionality:
- Add/edit/delete contacts
- Search contacts

*[Screenshot placeholder: Contacts interface with contact list and details]*

### eigen|stickies> - Kanban Boards
Trello-like board system:
- Create boards with lists and cards
- Drag and drop cards
- Real-time collaboration
- Multi-user editing without conflicts

*[Video placeholder: Multiple users moving cards on a shared board]*

## Technical Architecture

The current stack works well for the proof of concept. I'm not a professional front-end or back-end developer, so these choices are open for discussion and can definitely change based on community input.

**Key architectural decision**: All user data (except login credentials) is stored file-based, per user. Everything - documents, emails, contacts - lives in the user's own directory. I use SQLite databases for metadata and structured data, while the actual content is stored as files - not misusing databases as filesystems. No shared databases, no complex central systems.

This approach creates interesting technical challenges:
- How do you share documents when each user's data is completely isolated?
- How do you enable real-time collaboration without a central database?
- How do you handle search across a user's data when it's all file-based?

But these constraints also bring benefits:
- Natural data isolation and privacy
- Zero-knowledge by default - the server can't read user content
- Simple backup - just copy a user's directory
- Easy to scale - adding users doesn't affect existing ones
- Each user could even use different storage backends

The constraints push me to find creative solutions. The result: an architecture that's both privacy-preserving and naturally scalable.

**Backend:**
- Bun (JavaScript runtime)
- Elysia (web framework)
- SQLite (databases per user for metadata and structured data)
- YJS (conflict-free collaborative editing)

**Frontend:**
- React with TypeScript
- TanStack Router (type-safe routing)
- TanStack Query (data fetching)
- Tailwind CSS + shadcn/ui (responsive design for desktop and mobile)

**Infrastructure (Planned):**
- Docker containers for easy deployment
- Horizontal scaling architecture

The architecture is designed to support everything from a single user on a Raspberry Pi to thousands of users across multiple servers. The current proof of concept runs as a simple application, but the codebase is structured to support this scalable architecture.

## How to Move Forward?

Six weeks of spare time coding has resulted in something I'm genuinely excited about. A working proof of concept with real-time collaboration, file sharing, and multiple integrated apps. The per-user architecture works. The technical constraints I set have led to interesting solutions. It's real, it's running at eigen.is, and people can use it today.

But let me be honest: what exists now is maybe 5% of what this needs to become. To build a genuine alternative to Big Tech cloud suites - with calendar, spreadsheets, presentations, full encryption, organizational support, and protocol compatibility (IMAP, CalDAV, WebDAV) - I estimate this needs at least 10 person-years of focused development.

The foundation is solid, but the mountain ahead is high. Essential features still need to be built:
- **eigen|calendar>** with proper event management and sharing
- **eigen|sheets>** and **eigen|slides>** for complete office functionality  
- **End-to-end encryption** for all user data
- **Organization support** that feels natural despite the per-user architecture
- **Protocol compatibility** so eigen works with existing email and calendar clients
- **Backup and migration tools** to make switching easy

I realize I can't climb this mountain alone. The technical challenges are fascinating - how do you handle organizational calendars when each user has isolated data? How do you implement spreadsheet formulas in a collaborative environment? These are solvable problems, but they need more minds thinking about them.

That's why I'm planning to open source everything soon. I want to build a community of people who believe that Europe needs its own digital infrastructure. People who think privacy and data control aren't optional features but fundamental rights.

I'm looking for:
- **Developers** who want to tackle interesting technical challenges
- **Organizations** willing to test early versions and provide feedback
- **Investors or sponsors** who understand the strategic importance of European digital sovereignty
- **Anyone** who believes in the mission and wants to help shape the future of Eigen

If you're interested in any capacity - whether you want to contribute code, provide feedback, support the project financially, or just follow along - please get in touch. Together we can build something that gives people real choice about their digital workspace.

**Try the demo:** eigen.is  
**Contact:** [Your contact information here]  
**GitHub:** Coming soon

---

*Eigen - Your personal workspace in the cloud. Simple and secure. You control your own data.*
