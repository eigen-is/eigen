---
id: eigen-open-source
title: "Eigen: Open Source"
description: "Eigen is open source. You can try the public demo or install the workspace on your own server. Here is what's new, and how you can help."
---

Eigen is a European Google Workspace alternative where you own your data. In [the last post](https://eigen.is/blog/eigen-six-months-later) I listed three possible directions for the project: open source the code, find an organization to adopt it, or build a team around it.

I started with the first one, because I could do that myself.

The code has been on [GitHub](https://github.com/eigen-is/eigen) under the MIT license since May. Now it is time to invite the first self-hosters.

## Self-hosters first

Open sourcing Eigen sets the direction for development: self-hosters first. Eigen is for individuals, enthusiasts and small organizations who want to run it themselves. Larger organizations can follow later.

Deployment is one Docker Compose stack. A setup script asks a few questions and writes the configuration. HTTPS is automatic. Postfix and Dovecot are included, and standard clients can connect over IMAP, CalDAV, CardDAV and WebDAV. There are scripts for backups and updates. The [README](https://github.com/eigen-is/eigen) has the details.

Reality check: Eigen is pre-1.0.0. Expect rough edges, and expect breaking changes between versions until 1.0. If losing data would be a disaster for you, please wait a little longer.

If you self-host, this is where you can help: install Eigen and use it for real. Tell me what breaks, what is missing and what feels wrong. Open an issue on [GitHub](https://github.com/eigen-is/eigen/issues) or mail me. Pull requests are welcome too, but right now feedback from real use is the most valuable thing I can get.

## Try it in your browser

You can also try Eigen without installing anything.

Go to [demo.eigen.is](https://demo.eigen.is) and press "Enter demo". You land in a shared workspace as a member of a small festival team, with mail, files, documents, spreadsheets, stickies and a calendar already filled with data.

The demo is a real Eigen server. Everyone shares the same workspace. It resets every hour, and outgoing mail is disabled. So click around, edit things, break things. That is what it is for.

## What's new

Other additions since the last post:

- **Mobile**: every app now works properly on a phone.
- **Search**: press `Ctrl+K` (or `Cmd+K`) anywhere to search files, mail and contacts. Search looks inside documents too, and every editor has find and replace.
- **Version history**: docs, sheets, slides, stickies and chat keep automatic snapshots. Browse or restore any earlier version.
- **File activity**: every file has a timeline of what happened and who did it. Watch a file or folder to get notified when it changes.
- **Import**: `.xlsx` and `.docx` files convert into Eigen sheets and docs.
- **Contacts sync**: Eigen now has a CardDAV server. Sync your address book with the contacts app on your phone or laptop, or with Thunderbird and DAVx5. Contacts are stored as plain vCard files on the server, so your address book is yours even without Eigen. Labels and contact photos sync too.

The full list is in the [changelog](https://eigen.is/changelog).

## Making it sustainable

Eigen is still a spare-time project. I would like to spend more time on it, but that time needs to be paid for somehow. Public funding seems like the best fit, but I have no experience applying for it.

If you know which funds might suit a project like Eigen, or have experience writing subsidy applications, please get in touch. Even an hour of advice would help.

## How you can help

So: try the [demo](https://demo.eigen.is), install Eigen if you like what you see, and tell me how it goes. And if you can help with funding, I would love to hear from you.

[reinder@eigen.is](mailto:reinder@eigen.is) | [reindernijhoff.net](https://reindernijhoff.net/)
