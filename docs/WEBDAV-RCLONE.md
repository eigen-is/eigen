# Mounting your Eigen drive with rclone

`rclone mount` is the most reliable cross-platform way to expose your Eigen drive as a local folder. It works on macOS, Windows, and Linux, supports the Office locked-file dance via VFS write caching, and recovers cleanly from network blips.

If you're on macOS and just want it to look like a Finder server, **Mountain Duck** is simpler — see [WEBDAV-MOUNTAIN-DUCK.md](WEBDAV-MOUNTAIN-DUCK.md). Use rclone if you need scriptability, want it on Linux, or need rclone's bandwidth controls.

## 1. Install rclone

```bash
# macOS
brew install rclone

# Linux (Debian/Ubuntu)
sudo apt install rclone

# Linux (Fedora/RHEL)
sudo dnf install rclone

# Windows
scoop install rclone        # via scoop
# or: download installer from https://rclone.org/downloads/
```

## 2. Install the FUSE driver

`rclone mount` needs a userspace filesystem driver:

- **macOS**: install [FUSE-T](https://www.fuse-t.org/) (do *not* use macFUSE — it's blocked by Apple's stricter kext rules on recent macOS versions).
- **Windows**: install [WinFsp](https://winfsp.dev/).
- **Linux**: usually preinstalled. If not, `sudo apt install fuse3` or equivalent.

## 3. Generate an app password

In Eigen, open **Integrations** in the user menu, scroll to **App passwords**, give it a name (e.g. `rclone-laptop`), and click Generate. **Copy the password immediately** — it's only shown once.

## 4. Configure the rclone remote

Run `rclone config` and answer the prompts:

```
n) New remote
name> eigen
Storage> webdav
url> https://<your-eigen-host>/webdav/<your-user-id>/<your-mount-id>/
vendor> other
user> <your-email>
pass> <your-app-password>
```

The **Integrations** page shows one URL per mount you can access (your personal drives plus any team drives). Pick the one you want to mount and copy it verbatim — `<your-user-id>` is `team_<id>` for team drives.

Or write `~/.config/rclone/rclone.conf` directly:

```ini
[eigen]
type = webdav
url = https://eigen.example.com/webdav/abc123.../mnt_xyz789/
vendor = other
user = you@example.com
pass = <obscured-app-password>
```

(Use `rclone obscure <password>` to obfuscate the password before pasting.)

## 5. Mount

Pick a mount point, then:

```bash
mkdir -p ~/eigen-drive
rclone mount eigen: ~/eigen-drive \
    --vfs-cache-mode writes \
    --dir-cache-time 5s \
    --poll-interval 15s
```

`--vfs-cache-mode writes` is **required** for editing files in place — it lets Office and other apps write atomically to a local copy that rclone then uploads.

`--dir-cache-time 5s` keeps directory listings fresh; default of 5m hides changes made from the web UI for a long time.

`--poll-interval 15s` is unused for WebDAV (no native poll API), so listings refresh on `--dir-cache-time` only — leave the default if you don't care.

To run it in the background, append `--daemon` (Linux/macOS only):

```bash
rclone mount eigen: ~/eigen-drive --vfs-cache-mode writes --daemon
```

## 6. Unmount

```bash
# macOS / Linux
umount ~/eigen-drive
# or, if rclone holds the lock:
fusermount -u ~/eigen-drive

# Windows
# Press Ctrl-C in the rclone terminal, or close the WinFsp tray app entry.
```

## Known limitations

- **Eigen container files** (`.eigendoc`, `.eigensheets`, `.eigenslides`, `.eigenstickies`, `.eigenchat`) appear as folders containing `data.db` and a `media/` subfolder. The internals are read-only over WebDAV (`423 Locked`). You can move/rename/delete the container as a unit; you cannot edit `data.db` directly.
- **Office AutoSave** is disabled when files are mounted via WebDAV — Microsoft only enables it for OneDrive/SharePoint. Saves still work; AutoSave specifically does not.
- **Locked files** (Office's `~$Filename.docx`) are accepted on PUT but hidden from directory listings.
- **PROPFIND Depth: infinity** is rejected with 403 — this is per RFC 4918 §9.1 and prevents accidental full-tree fetches. Use `--dir-cache-time` to balance freshness vs round-trips.

## Troubleshooting

- **`401 Unauthorized` on every request** — your app password expired or was revoked. Generate a new one and update `rclone.conf`.
- **`404 Not Found` on PROPFIND of `/webdav/` or `/webdav/<user-id>/`** — those discovery levels are intentionally not exposed. The canonical URL is `/webdav/<owner-id>/<mount-id>/`; copy it from the **Integrations** page.
- **`403 Forbidden` on PROPFIND** — the user-id or mount-id in your URL is wrong, or you don't have access to that mount. Reload the **Integrations** page for the correct URL.
- **Office complains "another user has locked the file"** — a `.docx` LOCK is still active. Wait 10 minutes (the lock TTL) or call `rclone purge eigen:.locks/` if you've left zombies behind.
- **macOS**: if Finder freezes the first time you open the mount, restart Finder (`killall Finder`) — rclone needs a moment to populate the root cache.
