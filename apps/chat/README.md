# MUD-inspired Focused Chat

An innovative, focused chat platform inspired by classic MUDs (Multi-User Dungeons) and enhanced with the usability of modern group chat (Slack, WhatsApp, Signal) — designed to bring the "physical" feeling of presence, room-based interaction, and effective team communication together.

---

## Table of Contents

- [Introduction](#introduction)
- [Core Concepts](#core-concepts)
- [User Interface Overview](#user-interface-overview)
- [Rooms](#rooms)
- [Users](#users)
- [Messages & Emotes](#messages--emotes)
- [Private Conversations](#private-conversations)
- [Room Management](#room-management)
- [Peek Functionality](#peek-functionality)
- [Notifications & Presence](#notifications--presence)
- [Technical Considerations](#technical-considerations)
- [Wireframes](#wireframes)
- [Future Considerations](#future-considerations)

---

## Introduction

This chat system aims to reinvent textual group chat by focusing on “presence in space,” inspired by the room-based model and emote-driven style of MUDs. Unlike Slack/Discord where you "subscribe" to many channels, here you are always *in* a single room, bringing focus and context to interactions. Features like `/me` actions, peeking into rooms, expressive presence, and minimized notification noise are at the core.

---

## Core Concepts

- **Rooms act as spaces:** You are always *in* a room; you can move to others but are never in all at once.
- **Emphasis on awareness:** Entering/exiting is visible. Who is present, and current status, is always clear.
- **Peeking:** Instantly see what’s going on in any room, but you only "enter" a room if you commit.
- **Actions** (`/me`): Not just text, but actions to set tone and presence.
- **History:** When entering a room, you can browse all its message history.
- **Private chat:** 1-on-1 rooms (not separate DMs), maintaining the room model even for private conversations.
- **Sidebar:** List of rooms you’ve visited & people summary.
- **Quick, keyboard-friendly, minimal UI.**
- **Open to expansion:** Design supports future openness (federation), but MVP can be closed.

---

## User Interface Overview

### Main Layout (Desktop)
```
------------------------------------------
| Rooms      |   Chat Area               |
|------------|---------------------------|
| > #lounge  |  #lounge                  |
|   #kitchen |  Users: Alice, Bob        |
|   #dev     |---------------------------|
|   #private |  [10:31] Alice: hi Bob!   |
|------------|  [10:32] /me Bob waves    |
| People     |  ...                      |
| Alice (*)  |---------------------------|
| Bob (++)   |  [Input box here]         |
|------------| [say] [emote] [whisper]   |
| + New Room |---------------------------|
------------------------------------------
```

**Interactions:**
- Click-hold a room: peek into its history and presence; release to return to your current room
- Double-click or `/go <room>`: enter a room
- Sidebar shows rooms (visited and available), people (online & status)
- “+ New Room” to create a new space

---

## Rooms

- **You are present in exactly one room at a time.** *(Except for peeking)*
- Entering/leaving a room is visible to all present.
- All messages and /me-actions are scoped to that room.
- When you enter, see all chat history (scrollback); "headlines" or last few messages shown on arrival.
- Each room has a list of active users, always displayed.

---

## Users

- **Presence:** See current location and perhaps status/last action of every user.
- Sidebar shows "where" people are (e.g. Alice is in #kitchen, Bob is in #lounge).
- Optionally, quick hover/click on a user can suggest inviting them to a room or see their recent interactions with you.
- Status (automatic or manual): "reading", "typing", "idle", etc.

---

## Messages & Emotes

- Regular chat (`say` or just type message).
- Emotes (`/me <action>` or via button): shown in italics/colored, e.g. _Bob laughs_.
- Standard set of emotes (plus quick-buttons), but also free-form `/me`.
- All messages timestamped.

---

## Private Conversations

- **No "side-channel DMs":** Instead, private chat is simply a two-person room.
    - Easily create a room with one other person—appears in your room sidebar.
    - Option to invite more people (converts the room to group).
- Whispers: Short, one-off messages to another user in the same room.
    - `/whisper <user> <message>`
    - Whisper messages visible only to you and the recipient, shown inline.

---

## Room Management

- **New room creation:**
    - Button `+ New Room` opens dialog to name room, optionally invite users.
    - Command: `/new #roomname`
    - Default: rooms open (anyone can enter), can make closed (invite-only/private).
    - Open rooms can be browsed; private rooms visible only to members.
    - Invite by name, or share an invite link.

---

## Peek Functionality

- **Rooms list:** Shows all rooms you’ve entered recently, and all open rooms.
- **Peeking:** 
    - On desktop, click-and-hold a room entry to "peek" at its current state (roster, latest messages).
    - Release mouse: return to your active room, no enter/leave event triggered.
    - Double-click or `/go <room>`: actually move.
    - Useful for checking in without generating noise or distraction.
- Peeking always visually distinct (e.g. semi-opaque chat area, "Peeking into #dev..." banner).

---

## Notifications & Presence

- **You only receive notifications for your current room** (except for @mentions, direct invites, or ‘shout’ messages).
- Changing rooms is a conscious act—focus-first.
- Entering/exiting, and relevant actions, clearly shown on timeline for others.

---

## Technical Considerations

- **Backend retrieves and syncs full message history for each room.**
- **Room membership and peeking states tracked separately.**
- **Rooms and user presence broadcasted in real-time (WebSockets, similar to e.g. Slack but with "active room" focus).**
- **API upfront designed for expansion to federated/multi-server future.**
- **Security:** All content end-to-end encrypted (forward planning; for MVP can use standard WebSocket encryption).

---

## Wireframes

### Main App Layout

```
+-----------------------------------------------------------+
| #lounge (5)   #kitchen (2)    #dev (3)     + New Room     |
|                                                     [me]  |
|-----------------------------------------------------------|
| Active Room: #lounge              Users: Alice, Bob, You  |
|-----------------------------------------------------------|
| 10:30  Alice: Good morning!                               |
| 10:30  /me Bob waves                                      |
| 10:31  You: Hi all!                                       |
| ...                                                       |
|-----------------------------------------------------------|
| [ Say ] [ /me /emote ] [ Whisper ]             [ Leave ]  |
| > [Type here...]                                          |
+-----------------------------------------------------------+
```

### Sidebar/Peek Example

```
Rooms
----------------------
#lounge     (5)   *
#dev        (3)
#kitchen    (2)
#private-alice (2)
+ New Room

People
----------------------
Alice   [kitchen]
Bob     [lounge]
Sara    [dev]
You     [lounge]
```
- \* indicates your current room
- Greyed out or shrunken text when peeking

---

### Peeking

- User click-holds `#dev` in sidebar:
    - Main panel shows `#dev` messages and presence (preview-only overlay)
    - "Peeking into #dev..." note at top
    - On mouse release, jump straight back to your room
    - Double-click enters `#dev` for real

---

## Future Considerations

- **Open/federated protocol:** Long-term vision is open, non-proprietary, privacy-first.
- **End-to-end encryption for private/group rooms.**
- **Mobile support:** Room model maps cleanly to mobile tabs or drawer navigation.
- **Rich integrations:** Custom bots, file sharing, search, etc.—modular, not intrusive.
- **Themeable UI for accessibility/brand use.**

---

## Example User Stories

### 1. Room Navigation

- User enters the #lounge
- Bob is already in #lounge; Alice is in #kitchen
- User types `/me waves`, everyone in #lounge sees "*User waves*"
- User click-peeks into #kitchen: sees conversation and Alice present, without entering
- User double-clicks #kitchen to swap rooms (and is greeted by Alice)

### 2. Private Conversation

- User clicks on Alice in the sidebar, creates #private-alice room
- Discussion is private; only visible in their room lists
- If they want, can invite others, which turns it into a group room

### 3. Notification Handling

- User only gets message pings from their active room
- If @mentioned elsewhere, a badge appears on corresponding room in the sidebar

---

## End

This document outlines the foundational structure, user experience, and potential implementation details for a modern, MUD-inspired, focused chat app. It can serve as a spec/starting-point for development. For questions, clarifications, or contributions, contact the author.
