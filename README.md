# pitwall-recorder

Records the telemetry F1 25 sends while you play, so it can be used to build and test the Pitwall race engineer panel. It doesn't change anything in the game and sends nothing over the internet. It only writes files on your PC.

## How to record (Windows)

1. **Download** `pitwall-recorder.exe` from the [latest release](https://github.com/NikNam3/pitwall-recorder/releases/latest) and put it in its own folder (e.g. `Documents\pitwall-recorder`).
2. **Set up the game** (once): *Settings → Telemetry Settings*

   | Setting | Value |
   |---|---|
   | UDP Telemetry | **On** |
   | UDP Broadcast Mode | **Off** |
   | UDP IP Address | **127.0.0.1** |
   | UDP Port | **20777** |
   | UDP Send Rate | **60Hz** |
   | UDP Format | **2025** |
   | **Your Telemetry** | **Public** |

   > ⚠️ **Everyone in the lobby must set "Your Telemetry" to Public.** If someone leaves it on Restricted, everyone else's recordings are missing that player's fuel, tyre wear, damage and similar data. Positions and lap times still come through, so the recording *looks* fine but is much less useful.

3. **Double-click `pitwall-recorder.exe`** before you start the session. The first time, Windows SmartScreen may show "Windows protected your PC": click **More info → Run anyway**. (The program isn't signed; that's expected.)
4. **Play.** The window shows `● Recording new session` and a running packet count. Each session (practice, qualifying, race) goes into its own file.
5. **Stop** by pressing **Ctrl+C** or just closing the window. Recordings are in the `pitwall-recordings` folder next to the exe.
6. **Send the files** (`*.pwrec.gz`) plus a short note for each: track, session type, and anything notable (which lap you pitted, safety car, crashes, retirements). The notes are really useful because they let us check the panel against what actually happened.

Files are compressed while recording. If the game or PC crashes, the file is still usable up to about one second before the crash.

### Using SimHub (or another telemetry app) at the same time

Only one program can listen on port 20777. Start the recorder from a terminal in its folder with
```
pitwall-recorder.exe --forward 127.0.0.1:20778
```
and set the other app's UDP port to 20778. The recorder passes every packet on to it unchanged.

### Troubleshooting

- **"No data yet"**: check the settings above. The game only sends data while you're in a session, not in the main menu.
- **"port 20777 is already in use"**: another telemetry app is running. Close it, or see the section above.
- **Warning about the UDP format**: set *UDP Format* to **2025**.

---

## For developers

The format is specified in [FORMAT.md](FORMAT.md).

```
npm ci
npm test                               # unit + integration tests
npm run record -- --port 20777         # run the recorder from source (Node ≥ 22.18)
npm run inspect -- <file> [--json]     # summary: complete?, duration, packet counts and rates
npm run replay -- <file> --port 20777 --speed 1|10|max
npm run build:exe                      # single executable for this platform (needs an official Node binary)
npm run smoke                          # end-to-end check of the built executable
```

Releases: pushing a `v*` tag runs CI, which builds the exe on Windows, smoke-tests it and attaches it to a GitHub release.
