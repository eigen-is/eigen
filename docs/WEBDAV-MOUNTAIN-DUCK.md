# Mounting your Eigen drive with Mountain Duck

[Mountain Duck](https://mountainduck.io/) is the simplest way to mount your Eigen drive as a Finder/Explorer smart-folder. Files appear native; downloads are on-demand; uploads happen as you save.

If you need scriptability, bandwidth controls, or Linux support, use [WEBDAV-RCLONE.md](WEBDAV-RCLONE.md) instead.

## 1. Install Mountain Duck

Download from <https://mountainduck.io/> (commercial; free trial). macOS and Windows both supported.

Mountain Duck 5+ uses the native macOS File Provider API and Windows' Cloud Files API, so you no longer need separate FUSE-T or WinFsp installs.

## 2. Generate an app password

In Eigen, open **Integrations** in the user menu, scroll to **App passwords**, give it a name (e.g. `mountain-duck-mac`), and click Generate. **Copy the password immediately** — it's only shown once.

## 3. Add the bookmark

In Mountain Duck, click **+** to add a new bookmark and fill in:

| Field      | Value                                                          |
|------------|----------------------------------------------------------------|
| Protocol   | `WebDAV (HTTP/SSL)` (use HTTPS — Eigen requires it in prod)    |
| Server     | your Eigen host (e.g. `eigen.example.com`)                     |
| Port       | `443`                                                          |
| Path       | `/webdav/<your-user-id>/<your-mount-id>/`                      |
| Username   | your email address                                             |
| Password   | the app password you just generated                            |

The **Integrations** page shows one URL per mount you can access (your personal drives plus any team drives). Pick the one you want to mount; for team drives, `<your-user-id>` is `team_<id>`. Each mount needs its own bookmark.

Save the bookmark.

## 4. Connect

Double-click the bookmark in Mountain Duck. The mount appears as a smart-folder in Finder/Explorer. Files download on-demand when you open them and re-upload when you save.

## 5. Disconnect

Right-click the mount in Mountain Duck and choose **Disconnect**, or quit Mountain Duck.

## Known limitations

- **Eigen container files** (`.eigendoc`, `.eigensheets`, `.eigenslides`, `.eigenstickies`, `.eigenchat`) appear as folders containing `data.db` and a `media/` subfolder. The internals are read-only (`423 Locked`); you can move/rename/delete the container as a unit but cannot edit `data.db` directly.
- **Office AutoSave** is disabled for WebDAV mounts — Microsoft only enables it for OneDrive/SharePoint. Saves still work; AutoSave specifically does not.
- **AppleDouble files** (`._Foo`, `.DS_Store`) and Office lock files (`~$Foo.docx`) are accepted on PUT but hidden from directory listings.

## Troubleshooting

- **"Authentication failed" on connect** — wrong app password, or it was revoked. Regenerate on the Integrations page.
- **"Path not found"** — the mount-id in the path is wrong. Reload the Integrations page for the correct URL.
- **Files stuck "downloading"** — Mountain Duck's File Provider cache can wedge after a Mac wake-from-sleep. Right-click the mount → **Disconnect** → wait a few seconds → reconnect.
- **Word/Excel "another user has the file open"** — a stale lock from a prior session. Wait 10 minutes for the lock TTL to expire.
