---
title: "Find and replace text"
description: "Search the document you have open, step through the matches, and replace them one at a time or all at once."
type: how-to
category: Basics
tags: [docs, search, find, replace, editing]
related: [docs/create-and-edit, docs/comments, getting-started/search-and-command-palette]
crossSections: [sheets]
order: 25
updated: 2026-09-13
---

Every Eigen editor has a find bar for searching the document you already have open. It works the same way in
Docs, Sheets, Slides, Stickies boards, drawings, and the text and code editors built into Drive, and in some of
them it replaces what it finds as well.

## Open the find bar

There are three ways in:

- Press **⌘F** on a Mac, or **Ctrl+F** on Windows and Linux.
- Open the **Edit** menu in the toolbar and choose **Find**.
- Click the magnifying-glass button in the top right of the toolbar. Its tooltip reads **Find in document**. On a
  phone, the same entry sits in the **⋮** menu.

The bar appears in the top right of the editor. Type your term and the matches light up as you type.

To open it with the replace row already showing, press **⌥⌘F** on a Mac (**Ctrl+Alt+F** or **Ctrl+H** on Windows
and Linux), or choose **Find and replace** from the **Edit** menu.

## Step through the matches

The count inside the **Find** box tells you where you are. **1 of 12** means you're on the first of twelve
matches. If nothing matches your term, the box reads **No results**.

- Press **Enter** for the next match, or **Shift+Enter** for the previous one.
- Or click the down and up arrows beside the box (**Next match** and **Previous match**).
- **⌘G** and **⌘⇧G** (**Ctrl+G** and **Ctrl+Shift+G**) step forwards and backwards too. They work even when the
  bar is closed, using your last term.

Every match stays highlighted, and the editor scrolls the current one to the middle of the screen so the bar
can't cover it. The search covers the whole document, not the part you're looking at: in Sheets it runs across
every tab, and in Slides across every slide, so stepping on can move you somewhere else in the file.

## Narrow what counts as a match

Three toggles sit at the right-hand end of the **Find** box:

- **Match case**: only match text with the same capitalisation.
- **Whole word**: skip matches inside a longer word, so "art" no longer matches "start".
- **Regex**: treat your term as a regular expression.

## Replace what you find

Replace is available in Docs, Sheets, and the text and code editors built into Drive. You also need write access:
on a document you can only view, the find bar searches and nothing more. Slides, boards, and drawings search
without replacing.

1. Open the find bar and type the term you want to change.
2. Click the arrow at the left of the bar to show the replace row. Its tooltip reads **Show replace**, and
   changes to **Hide replace** once the row is open.
3. Type the new text in the **Replace** box.
4. Click **Replace** to change the current match and move on to the next one. Pressing **Enter** in the
   **Replace** box does the same thing.
5. Click **All** to change every match in one go. A short **Replaced 12** note tells you how many were changed.

Turn on **Preserve case** in the replace row if you want each replacement to take on the capitalisation of the
text it replaces.

A replace is an ordinary edit, so you can undo it. Press **⌘Z** (**Ctrl+Z**) without leaving the bar.

<div class="eigen-callout">

In Sheets, a replace rewrites the contents of a cell. Cells holding a formula are left alone, even when the
result they show matches your term, and so are locked cells on a protected sheet. Those cells stay in the match
count afterwards.

</div>

## Search the comments as well

The find bar looks at the text of the document itself. Comments aren't part of that.

To search the discussion on a document or a board, open the command palette with **⌘K** (**Ctrl+K**) while the
file is open, then type `doc:` followed by your term. Matches in the text appear under **In Document**, and
matches in comment threads under **In Comments**. Press **Enter** on one to jump to it. See
[Find anything with search and the command palette](/support/getting-started/search-and-command-palette) for the
rest of what the palette can do.

## Close the find bar

Press **Esc**, or click the **Close** button at the right-hand end of the bar. The highlights go with it. Your
term is remembered, so the next **⌘F** brings it back ready to edit.
