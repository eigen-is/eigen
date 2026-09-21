---
title: "Import contacts from a vCard file"
description: "Bring contacts into Eigen from a .vcf file, either from your computer or from a file already in Drive."
type: how-to
category: Basics
tags: [contacts, import, vcard, vcf]
related: [contacts/export-contacts, contacts/get-started, connect/contacts-client, drive/preview-a-file]
order: 90
updated: 2026-09-21
---

Most address books can save contacts as a vCard file, which has the extension `.vcf`. Contacts reads those files, so you can bring people over from a phone, from another mail provider, or from a colleague who sent you a card.

## Import from the contact list

1. Open [Contacts](/contacts) and click **My Contacts** in the sidebar.
2. Click the **⋮** button at the top of the list.
3. Click **Import contacts…**. The **Import contacts** dialog opens.
4. Pick the file in one of two ways:
   - Click **Upload from device**, then choose a `.vcf` file from your computer.
   - Or browse your Drive, click a `.vcf` file, and click **Select**.

Eigen reads the file and tells you what it did, for example "Imported 12 contacts, skipped 3 duplicates". The new contacts appear in the list straight away.

The **⋮** button is not there when you are looking at a team. Team members are managed by whoever administers the team, so there is nothing to import into.

## Import a file you already have in Eigen

You can import a `.vcf` file without opening Contacts.

1. Find the file in [Drive](/drive), or as an attachment on an email, a chat message, or a card.
2. In Drive, right-click the file or click its **⋮** button. For an attachment, right-click the chip, or press and hold it on a phone.
3. Click **Import to Contacts**.

You can also look inside the file first. Select it and press **Space**, or choose **Quick preview** from the same menu. The preview shows each contact in the file as a card, with photo, addresses, and labels, up to the first 200. The bar at the bottom has the same **Import to Contacts** button. See [Preview a file](/support/drive/preview-a-file).

## What comes across

- Names, email addresses, phone numbers, postal addresses, company and job title, birthday, and notes.
- The photo, when the file has the image stored inside it. A photo the card only links to by web address is left as a link and not fetched.
- Categories become labels. A label that does not exist yet is created for you, with a color chosen from the Eigen palette.
- Everything else the card holds is kept as it is, including fields Contacts does not show you. It comes back out when you [export the contact](/support/contacts/export-contacts).

Contact groups, the kind Apple Contacts creates, are skipped. Contacts organizes people with labels instead.

## Duplicates are skipped, never merged

A contact in the file is skipped when it is already in your address book. Two things count as already there:

- The contact carries the same identifier as one you already have. Every card Eigen stores carries one, so re-importing a file you exported from Eigen adds nothing.
- The contact's first email address is already on one of your contacts. The match ignores capitals.

If a contact's first email address is already on a contact earlier in the same file, only the earlier one is imported.

Skipped contacts are counted in the message at the end. Nothing you already had is changed, overwritten, or merged with anything.

## Limits

- A file can be up to 20 MB, and can hold up to 1000 contacts. A bigger file is refused as a whole, so split it before you import.
- The file has to be saved as UTF-8, which is what every current address book writes. A file in an older encoding is refused with a message saying so; open it in a text editor and save it again as UTF-8.
- A single contact can be up to 5 MB. That is only a problem when a card carries a very large photo. Such a card is counted as unreadable, and the rest of the file still goes in.
- Contacts share a storage allowance with Mail. If you run out part way through, the import stops and tells you how many contacts went in. Those contacts stay.

## If nothing is imported

A message saying **No contacts found in this file** means the file was readable but held no contact Eigen could take. If the file is not a vCard file at all, you get a **Not a vCard file** error instead and nothing is imported. Open the file in a text editor to check: a vCard file starts with the line `BEGIN:VCARD`.

Contacts that could not be read are counted separately in the message, as "unreadable". The rest of the file is still imported.
