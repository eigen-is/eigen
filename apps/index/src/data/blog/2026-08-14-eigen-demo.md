---
id: eigen-demo
title: "Eigen: Try the Demo"
description: "A live, browser-based demo of Eigen is now available. It features a shared, hourly-resetting workspace running the full stack."
---

I am still working on Eigen, a self-hosted alternative to Google Workspace.
Until now, if you wanted to try it, you had to ask me for an account or install it yourself.

To make testing easier, I have set up a public demo at [demo.eigen.is](https://demo.eigen.is). Press "Enter demo" and test Eigen without having an account.

## Tuimel Festival

The demo is not empty.
You land in a pre-filled, shared workspace of a fictional group of volunteers that are organizing the Tuimel Festival.
Tuimel Festival is loosely based on the (very nice) Dutch [Festival Hongerige Wolf](https://www.festivalhongerigewolf.nl/).

The Tuimel Festival in the demo is (always) three weeks away, the line-up is basically done, and—as expected—there are not enough volunteers yet.

You join as one of the twenty people on the crew. Every time you enter, you are assigned a random crew member profile.
That person has a mailbox, a calendar, active chats with the team, and a shared drive containing a budget sheet, a sponsor deck, a production plan, and a site plan.

Everything is made up, but the workspace has comments, history, and unread messages, so you can see how the interface behaves in a real-world scenario.

## All apps work

I installed this demo on a very cheap, small server. I am interested to see how the architecture holds up under random public load, so please let me know if you see any errors or slowdowns.

It is a real Eigen server, so all apps are there: mail, drive, docs, sheets, slides, stickies, chat, calendar, contacts, and vector.
The only thing that is switched off is outgoing mail.

Real-time collaboration works too. If you open the same document in a second browser window (using a private window, so you enter as a different crew member),
you will see two cursors in the same text.

## It resets every hour

Everyone in the demo shares the same workspace. You will see changes made by other visitors in real-time, and they will see yours.

To keep things clean, the workspace is wiped and rebuilt every hour. Whatever you do in there is gone within the hour, so feel free to edit, break, or delete as much as you like. That is what it is for.

## Feedback

If you try the demo, I would like to hear what you think. Tell me what breaks, what is missing, and what feels wrong.

[reinder@eigen.is](mailto:reinder@eigen.is) | [reindernijhoff.net](https://reindernijhoff.net/)
