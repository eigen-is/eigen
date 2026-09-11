---
title: "Select, arrange, and align objects"
description: "Select objects on a Vector canvas, move and resize them, set exact positions, change the stacking order, and line them up."
type: how-to
category: Editing
tags: [vector, selection, align, arrange, layers]
related: [vector/draw-shapes-and-text, vector/style-objects, vector/zoom-pan-and-shortcuts]
order: 40
updated: 2026-09-11
---

Once you have a few objects on a drawing, Vector gives you the tools to place them exactly. This article covers selecting objects, moving and resizing them, setting exact values, changing the stacking order, and lining objects up with each other.

## Select objects

Make sure the **Select** tool is active, then:

- **Click** an object to select it. Handles appear at its edges and corners.
- **Shift-click** another object to add it to the selection, or to remove one that's already selected.
- **Drag on an empty part of the canvas** to draw a marquee. Every object it covers is selected. **Shift-drag** adds the marquee's objects to the current selection instead of replacing it.
- Press **⌘A** (Mac) or **Ctrl+A** (Windows) to select every object on the drawing.
- Press **Esc** to clear the selection.

## Move, resize, and rotate

With one or more objects selected:

- **Move**: drag the selection to a new spot.
- **Resize**: drag a corner or edge handle.
- **Rotate**: drag the rotation handle above the selection.
- **Nudge**: press an arrow key to move the selection one pixel. Hold **Shift** and press an arrow key to move it five pixels.

## Set an exact position and size

The properties panel on the right has a **Transform** section with a field for each measurement. Type a value into any of them to set it precisely:

- **X** and **Y**: the position of the object.
- **W** and **H**: its width and height.
- **Angle**: how far it's rotated, in degrees.

Tick **Keep aspect ratio** to lock width and height together, so changing one changes the other in proportion.

## Snap to other objects

As you drag or resize an object near another one, Vector shows thin guide lines when their edges or centres line up, and pulls the object onto that line. This helps you match positions by eye without typing exact values. The guides disappear as soon as you move away.

## Duplicate, copy, cut, and delete

- **Duplicate**: press **⌘D** (Mac) or **Ctrl+D** (Windows), or right-click the selection and choose **Duplicate**. You get a copy on the same drawing.
- **Copy** with **⌘C**, **cut** with **⌘X**, and **paste** with **⌘V** (use **Ctrl** on Windows). You can also copy, cut, and paste from the right-click menu, and paste into another Vector drawing.
- **Delete**: press **Delete** or **Backspace**, or right-click and choose **Delete**.

## Change the stacking order

Objects stack in the order you add them, with newer objects in front. To reorder the selection, use the **Arrange** section of the properties panel, or the right-click menu. Four actions are available:

- **Bring to front** (**⌘⇧]**): move it above everything.
- **Bring forward** (**⌘]**): move it up one step.
- **Send backward** (**⌘[**): move it down one step.
- **Send to back** (**⌘⇧[**): move it below everything.

Use **Ctrl** in place of **⌘** on Windows.

## Align and distribute

Select two or more objects and an **Align** section appears in the properties panel. Hover over a button to see what it does:

- **Align left**, **Align horizontal center**, or **Align right** to line objects up along a vertical edge or their centres.
- **Align top**, **Align vertical center**, or **Align bottom** to line them up along a horizontal edge or their centres.
- **Match width** or **Match height** to give every selected object the same size in that direction.

Select three or more objects to unlock **Distribute horizontally** and **Distribute vertically**, which spread the objects out with equal gaps between them.

## The right-click menu

Right-click any object to open its menu. The actions are grouped in this order:

1. **Bring to front**, **Bring forward**, **Send backward**, **Send to back**.
2. **Copy**, **Cut**, **Paste**.
3. **Duplicate**, **Delete**.
4. **Add comment**.

<div class="eigen-callout">

Vector has no group command. To move several objects together, select them all first, then move, align, or arrange the whole selection at once.

</div>

For the full list of keyboard shortcuts, see [Zoom, pan, and keyboard shortcuts](/support/vector/zoom-pan-and-shortcuts).
