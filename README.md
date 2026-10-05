<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="ACT 3 icon">

# Modified Coucou (ACT 3)

**A Windows desk buddy inspired by Coucou, rebuilt as ACT 3.**

Keep an AI companion at the top of your screen, use Ollama or OpenRouter, create reusable AI tasks, run focus timers, and chat without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

Download **`ACT-3-Windows-X.Y.Z-setup.exe`** or **`setup.exe`** from the latest
GitHub Release and run it. The installer is unsigned, so Windows SmartScreen may
show a warning; only continue if you downloaded it from this repository and
trust the source.

ACT 3 installs for the current Windows user and does not require administrator
access. Configure Ollama in Settings, or choose an online provider and add your
API key.

To check for a newer version, open **Settings → Updates → Check for updates**.
ACT 3 opens the matching GitHub Release so you can download and run the installer.

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with ACT 3 from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mochi peeks out |
| Click the small island | It opens |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Mochi.

### Tasks

Open the **Tools** tab to run a quick action or make a reusable task. Saved tasks
can have any name and instructions; ACT 3 sends them to the selected OpenRouter
or Ollama model and displays its response. They do not change files or apps
automatically. Quick actions can open a URL or web search, open an existing
local file or folder, copy text, start a focus timer, and set a reminder.
Creating a new text note always requires explicit confirmation and refuses to
overwrite an existing file.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Coucou's entries.

The relay is a tiny executable, `coucou-hook.exe`, copied to
`%LOCALAPPDATA%\Coucou\bin\` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

## Chat and keys

**Settings… → AI provider** selects the chat provider and model.
OpenAI-compatible and OpenRouter keys live in the **Windows Credential Manager**,
never on disk or in the interface; local Ollama does not require a key.
Anthropic chat support has been removed. Claude Code hooks remain a separate
integration and can be left disabled if you do not use Claude Code.

No telemetry. The update checker contacts GitHub only when you request a check;
chat and integrations connect only to the services you configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `release/`:

```
ACT-3-Windows-X.Y.Z-setup.exe    the versioned installer
ACT-3-Windows-setup.exe          the same file under the rolling name
```

The GitHub Release also includes `setup.exe`, a copy of the versioned installer.
To publish a release, update the version in `Cargo.toml` and
`src-tauri/tauri.conf.json` to the same value, then push a matching `vX.Y.Z` tag.
The GitHub Actions release workflow builds the Windows installer and attaches it
to a generated GitHub Release. The in-app update check reads that release.

The installer adds an **ACT 3** shortcut to the Windows Start menu. Installing is
optional — `target/release/act3.exe` runs on its own. There is no window in the
taskbar and no console: the island at the top of the screen and the Mochi in the
notification area are the whole app, and Quit lives in its menu.

Sound effects are served and bundled from `assets/sounds/`. The path is declared
once, in `SOUNDS_DIR` at the top of `vite.config.ts`.

The app icon and the tray icon are drawn in code, like Mochi itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, provider clients, pollers
  hook/                coucou-hook.exe, the Claude Code relay
  scripts/             icon generator
```

### Log

`%LOCALAPPDATA%\Coucou\coucou.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## What's different from the Mac version

- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Not in this version: sending a file by email, dragging Mochi onto a window to
  attach it as context, and jumping to a specific terminal window — "Open
  terminal" opens the working folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.

## Linux

The same app builds for Linux: everything that differs lives in
`src-tauri/src/platform/`, and the relay's transport in `hook/src/unix.rs`.

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # AppImage, .deb and .rpm in windows/release/
```

What changes on Linux:

- **The island** is a gtk-layer-shell overlay anchored to the top edge, over any
  top panel, on compositors that support it: COSMIC, KDE Plasma, Hyprland, Sway
  and other wlroots compositors. GNOME has no layer-shell, so there the island
  is a regular window. `COUCOU_LAYER_SHELL=0` forces that mode anywhere.
- **Click-through** is the window's input region, kept equal to the island
  shape, so the compositor sends every other click to what is underneath.
- **Mochi's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else.
- **Claude Code hooks** go through `~/.local/share/coucou/bin/coucou-hook` and a
  Unix socket at `$XDG_RUNTIME_DIR/coucou.sock`. Both ends check that the other
  runs as the same user.
- **Keys** live in the Secret Service (GNOME Keyring, KWallet).
- **Files**: preferences in `~/.config/coucou/`, the log at
  `~/.local/share/coucou/coucou.log`.
- What the Windows build leaves out, this one does too: sending a file by
  email, dragging Mochi onto a window, and jumping to a specific terminal
  window — "Open terminal" opens the folder in VS Code.
