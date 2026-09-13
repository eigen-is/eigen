---
title: "Export contacts as a vCard file"
description: "Download one contact, a selection, or your whole address book as a .vcf file you can open in another app."
type: how-to
tags: [contacts, export, download, vcard, vcf]
related: [contacts/import-contacts, contacts/work-with-several-contacts, connect/contacts-client]
order: 100
updated: 2026-09-13
---

Contacts can hand you a vCard file, the `.vcf` format address book apps read. Use it to move people into another app, to send someone a card, or to keep a copy of your own.

## Export your whole address book

1. Open [Contacts](/contacts) and click **My Contacts** in the sidebar.
2. Click the **⋮** button at the top of the list.
3. Click **Export all contacts**.

Your browser downloads a file called `contacts.vcf` holding every contact in your address book, including your own card.

## Export one contact

1. In the contact list, right-click the contact, or hover over the row and click its **⋮** button.
2. Click **Export vCard**.

The file is named after the contact, for example `Jane Smith.vcf`.

## Export several contacts at once

1. Select the contacts you want. Hold Cmd (Ctrl on Windows) and click each one, or click the first and Shift-click the last.
2. Right-click any of the selected rows.
3. Click **Export 3 vCards**. The number matches your selection.

You get a single `contacts.vcf` file with all of them in it. See [Work with several contacts at once](/support/contacts/work-with-several-contacts) for more on building a selection.

## What the file contains

Eigen writes out the card exactly as it is stored, so nothing is lost on the way:

- Names, email addresses, phone numbers, postal addresses, company and job title, birthday, and notes.
- The contact photo, stored inside the file.
- Labels, stored on the card as its categories.
- Any field another app put on the card that Contacts does not show you. It is kept and written back out.

The file is plain text in the vCard 3.0 format, the same version Eigen serves to phones and desktop address books over CardDAV.

## What you can do with the file

- Open it in another address book app, or import it into one.
- Import it into another Eigen account. See [Import contacts from a vCard file](/support/contacts/import-contacts).
- Keep it as your own copy of your address book.

To keep a phone in step with Eigen continuously, rather than taking a copy now and then, connect it over CardDAV instead. See [Set up Eigen Contacts in a contacts app](/support/connect/contacts-client).

Team members cannot be exported. A team has no **⋮** button above its list, and a member's own page has no export option, because a team member is not a card in your address book.
