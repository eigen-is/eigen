---
title: "Assign and resolve cards"
description: "Give a Stickies card an owner, and mark it resolved once the work on it is finished."
type: how-to
tags: [stickies, cards, kanban, assignee, resolve]
related: [stickies/add-and-edit-cards, stickies/filter-a-board, stickies/card-comments]
order: 35
updated: 2026-11-19
---

An assignee says who is looking after a card. Resolving a card says the work on it is done. Both need write access to the board.

## Assign a card

The quickest route is the card itself.

1. Right-click the card on the board.
2. Point at **Assign to**.
3. Choose **Me**, **Unassigned**, or a person from the list.

You can only assign a card to someone the board is shared with, so share the board first. See [Share a board and manage access](/support/stickies/share-board).

You can also set the assignee while you fill a new card in. The dialog has an **Assignee** control next to the **Color** swatches, reading **Unassigned** until you pick someone. Click it and choose **Assign to me**, **Unassigned**, or a person from the list. It is saved with the rest of the card.

An open card has the same control in the row at the bottom of the card. Picking someone there takes effect straight away.

If you assign a card to someone else, they get a notification. A guest also gets an email that names the card and links to it, because a guest rarely has Eigen open. Someone the board is shared with who has no account yet gets only the email. These are the defaults, and the server owner can change them in [Server settings](/support/admin/server-settings).

A person gets at most one email an hour for each board. Any other cards you assign them in that hour reach them only in Eigen: in the bell, and as the colored ring on their avatar on the card. Someone with no account yet sees those cards only once they sign in.

To take the assignee off again, choose **Unassigned**.

On the board, the assignee shows as a small avatar in the bottom corner of the card. On an open card assigned to you, the avatar has a colored ring, so the cards waiting on you stand out.

::: video src="/data/about/media/stickies-assign" caption="A card assigned to someone from its menu, then taken off again."
:::

## Resolve a card

1. Click the card to open it.
2. Under **Status**, at the bottom of the card, click **Resolve**.

The button now reads **Resolved**, and a tick appears before the title. On the board the card stays where it is, with a small tick in its bottom corner to show it is resolved.

To bring it back, open the card and click **Resolved** again.

The right-click menu does both without opening the card: **Resolve sticky** on an open card, and **Reopen sticky** on one that is already resolved.

## Show only what is still open

A board shows resolved and open cards together. To hide the resolved ones, open the **Filter** menu in the toolbar, point at **Status**, and choose **Open**. The same menu filters by assignee, so **Assigned to** → **Me** gives you your own cards. See [Filter the cards on a board](/support/stickies/filter-a-board).
