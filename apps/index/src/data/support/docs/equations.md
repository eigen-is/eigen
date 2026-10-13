---
title: "Insert and edit equations"
description: "Add a math equation to a document, write it in LaTeX or pick symbols from menus, and show it inline or on its own line."
type: how-to
category: Basics
tags: [docs, equations, math, latex, editor]
related: [docs/images-and-tables, docs/export, docs/comments]
order: 55
updated: 2026-10-13
---

You can put math in a document, from a quick x² in a sentence to a formula on a line of its own. You write each equation in LaTeX, the notation most math tools use, and a preview shows how it will look as you type.

You need edit access to insert or change an equation. On a phone, equations show in the document, but you can't insert or edit them.

## Insert an equation

1. Place your cursor where the equation should go.
2. Open the **Insert** menu and choose **Equation**.
3. An empty equation appears at the cursor as a dashed box, and the **Equation** panel opens on the right with the cursor in its **LaTeX** field.
4. Type the equation, for example `x^2 + y^2 = r^2`. The preview at the top of the panel draws it as you type.
5. Press **Enter**. The equation is saved, and your cursor goes back to the document, right after the equation.

Leaving the field, for example by clicking back in the document, saves the equation too. Press **Escape** to throw away what you typed since the last save.

## Write LaTeX

Eigen reads the common LaTeX math commands: `\frac{a}{b}` for a fraction, `\sqrt{x}` for a root, `x_i` and `x^2` for scripts, `\sum`, `\int`, Greek letters such as `\alpha`, and environments such as `cases` and `pmatrix`.

Type a command's name and a space, and Eigen adds the braces it needs. `\frac` and a space becomes `\frac{}{}`, with the cursor in the first pair. An empty pair shows as a dotted box in the preview, so you can see what's left to fill in.

If the LaTeX has a mistake, the field turns red and a message under it says what's wrong, with the spot underlined. The equation isn't saved until you fix it, and the preview keeps showing the last version that worked.

## Pick symbols from the menus

Above the **LaTeX** field are five buttons, each opening a grid of symbols, as in Google Docs:

- **Greek letters** (α)
- **Miscellaneous operations** (±)
- **Relations** (≤)
- **Math operations** (√): fractions, roots, scripts, brackets, sums, integrals, and limits
- **Arrows** (→)

Click a symbol to add it at the cursor in the field. A fraction, a root, or another template puts the cursor in its first empty slot.

## Show an equation on its own line

An equation sits in the line of text by default. To give it a line of its own, centered, turn on **Display** under **Layout** in the **Equation** panel. Turn it off to put the equation back in the text.

## Change or remove an equation

Click an equation to select it and open its panel, then edit its LaTeX. You can also move onto it with the arrow keys and press **Enter**. To remove an equation, select it and press Backspace or Delete.

Other people see your changes once you save them, not while you type. If two people change the same equation, the last one saved wins.

## Comment on an equation

Click the equation, then press Cmd+Option+M (Mac) or Ctrl+Alt+M (Windows), or choose **Comment** from the **Insert** menu. The comment's **Title** starts as the equation's text. A commented equation shows a small triangle in the comment's color at its top-right corner. Click the triangle to open the comment. See [Comment and discuss](/support/docs/comments).

## Equations in Word files and downloads

When you download a document as a Word file, each equation becomes a Word equation that you can edit in Word, and a displayed one stays on its own line. Word has no place for LaTeX, so the file keeps the equation but not what you typed. A web page download keeps equations as math.

## Word count, search, and copying as text

Word count, search, and a copy pasted as plain text read an equation in a one-line text form, such as `x^2`, `(a+b)/2`, or `√(x+1)`. The find bar doesn't look inside equations.
