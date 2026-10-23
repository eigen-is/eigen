---
title: "Insert and edit equations"
description: "Add a math equation to a document, write it in LaTeX or pick symbols from menus, and show it inline or on its own line."
type: how-to
category: Basics
tags: [docs, equations, math, latex, editor]
related: [docs/images-and-tables, docs/export, docs/comments]
order: 56
updated: 2026-10-23
---

You can put math in a document, from a quick x² in a sentence to a formula on a line of its own. You write each equation in LaTeX, the notation most math tools use, and a preview shows how it will look as you type.

You need edit access to insert or change an equation. On a phone, equations show in the document, but you can't insert or edit them. In a header or footer you can change an equation that's there, but you can't insert one.

## Insert an equation

1. Place your cursor where the equation should go.
2. Open the **Insert** menu and choose **Equation**.
3. An empty equation appears at the cursor as a dashed box, and the **Equation** panel opens on the right with the cursor in its **LaTeX** field.
4. Type the equation, for example `x^2 + y^2 = r^2`. The preview at the top of the panel draws it as you type.
5. Press **Cmd+Enter** (**Ctrl+Enter** on Windows and Linux), or click outside the field. The equation is saved, and your cursor goes back to the document, right after the equation. **Enter** starts a new line in the field, which keeps long LaTeX readable and draws the same equation.

Leaving the field, for example by clicking back in the document, saves the equation too. Press **Escape** to throw away what you typed since the last save.

## Write LaTeX

Eigen reads the common LaTeX math commands: `\frac{a}{b}` for a fraction, `\sqrt{x}` for a root, `x_i` and `x^2` for scripts, `\sum`, `\int`, Greek letters such as `\alpha`, and environments such as `cases` and `pmatrix`.

Type a command's name and a space, and Eigen adds the braces it needs. `\frac` and a space becomes `\frac{}{}`, with the cursor in the first pair. An empty part of a fraction, a root, or another template shows as a dotted box in the preview, so you can see what's left to fill in.

If the LaTeX has a mistake, the field turns red and a message under it says what's wrong, with the spot underlined. The equation isn't saved until you fix it, and the preview shows the equation as it was last saved.

You can also paste MathML, starting with `<math`, into the field. Eigen reads it as the equation, and once it's saved the field shows its LaTeX.

## Pick symbols from the menus

Above the **LaTeX** field are five buttons, each opening a grid of symbols, as in Google Docs:

- **Greek letters** (α)
- **Miscellaneous operations** (±)
- **Relations** (≤)
- **Math operations** (√): fractions, roots, scripts, brackets, sums, integrals, and limits
- **Arrows** (→)

Click a symbol to add it at the cursor in the field. A fraction, a root, or another template puts the cursor in its first empty slot.

## Show an equation on its own line

An equation sits in the line of text by default. To give it a line of its own, centered, choose **On its own line** next to **Style** under **Layout** in the **Equation** panel, or right-click the equation and choose **On its own line**. Choose **In line with text** to put the equation back in the text.

## Change or remove an equation

Click an equation to select it and open its panel, then edit its LaTeX. To open the panel with the cursor in its **LaTeX** field, move onto the equation with the arrow keys and press **Enter**, or click the selected equation again. To remove an equation, select it and press Backspace or Delete.

Right-click an equation for **Cut**, **Copy**, **Edit equation**, which opens its panel with the cursor in the **LaTeX** field, **In line with text** and **On its own line**, **Add comment**, and, last and in red, **Delete equation**.

Other people see your changes once you save them, not while you type. If two people change the same equation, the last one saved wins.

## Paste equations

Copy an equation from Word for the web, or from a web page that shows math, and paste it into a document. It comes in as an equation you can edit, in the line or on its own line as it was. When the page includes the equation's LaTeX, the **LaTeX** field shows it.

An equation copied from one Eigen document to another stays an equation, with its LaTeX. An equation copied from Google Docs pastes as plain text. So does one from some web pages, which draw their math without keeping a copy of it. Pasted into a comment, an email, or a text box on a slide, an equation comes in as one-line text, such as `(a+b)/2`. To bring in the equations of a Word file, [import the file](/support/docs/import-word).

## Comment on an equation

Right-click the equation and choose **Add comment**. Or click the equation, then press Cmd+Option+M (Mac) or Ctrl+Alt+M (Windows), or choose **Comment** from the **Insert** menu. The comment's **Title** starts as the equation's text. A commented equation shows a small triangle in the comment's color at its top-right corner. Click the triangle to open the comment. See [Comment and discuss](/support/docs/comments).

## Equations in downloads and search

A Word download turns each equation into a Word equation, and a PDF or web page download draws it. See [Export to Word, PDF, or HTML](/support/docs/export) for what each format keeps.

Word count, searching your files, and a copy pasted as plain text read an equation in a one-line text form, such as `x^2`, `(a+b)/2`, or `√(x+1)`. The find bar inside a document doesn't look inside equations.
