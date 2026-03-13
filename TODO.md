# High Priority

[] Calendar FE App
[] Add organisation user and home.
[] Stable config system for server, organisations, teams and users using stored json file in their homes.
[] Store uploaded media files in slides/docs/chat by name vs pathId, so we can support copy of documents later on.
[] Have another look at the clipboard system. Make it rock solid, cross app, cross tab, etc. Support copy and embedding of SVG.

## Questions
[] Add hash to DrivePath?

# Med Priority

[] Refactor and cleanup Calendar app
[] Make sure Maildir on server follows exactly the imap folder structure. Monitor changes and update accordingly.
[] POC: implement imap sync with maildir
[] POC: implement CalDAV sync with calendar
[] Implement import and export of common file formats (PDF, DOC, XLS, etc.)
[] Add eigen|vector> similar to https://excalidraw.com/ . This drawing should be an easy to re-use component, so it can also be embedded in docs/slidees and maybe mail?

## Questions
[] Where and how do we handle file formats queued / at different threads?

# Low Priority

[] Cleanup Fortune-sheet mess
[] Fix everything