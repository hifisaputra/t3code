# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, and OpenCode, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Remote access over Tailscale

Run T3 Code on one machine (your dev box, a home server, etc.) and use it from
your phone or laptop over your private [Tailscale](https://tailscale.com)
network — nothing is exposed to the public internet.

### 1. Prerequisites

- [Install Tailscale](https://tailscale.com/download) and sign in on **both** the
  host and the device you'll connect from (same tailnet).
- Authenticate at least one provider on the host (see [Installation](#installation)).

### 2. Run the server

T3 Code listens on `127.0.0.1:3773` by default:

```bash
npx t3@latest
```

Useful flags (`npx t3@latest --help` for the full list):

- `--port <number>` — change the port (default `3773`).
- `--host <iface>` — bind address, e.g. `127.0.0.1`, `0.0.0.0`, or a Tailnet IP.

Keep the default `127.0.0.1` bind and put Tailscale in front (next step); that
keeps the server off every other interface.

### 3. Expose it over HTTPS with Tailscale

Notifications (Web Push) and other browser features require a **secure context**
(HTTPS), so front the server with `tailscale serve` instead of hitting the raw
port over HTTP.

Enable **MagicDNS** and **HTTPS Certificates** once in the
[Tailscale admin console](https://login.tailscale.com/admin/dns), then on the host:

```bash
# proxy HTTPS on your tailnet -> the local T3 Code server, in the background
tailscale serve --bg 3773

# print the https://<machine>.<tailnet>.ts.net URL
tailscale serve status
```

Open that `https://<machine>.<tailnet>.ts.net` URL from any device on your
tailnet. Stop serving later with `tailscale serve reset`.

> [!WARNING]
> Use `tailscale serve` (private to your tailnet) — **not** `tailscale funnel`,
> which publishes to the public internet.

### 4. Keep it running in the background

`tailscale serve --bg` already persists on its own. To keep the T3 Code process
running too:

**Linux (systemd user service)** — survives logout and starts on boot:

```ini
# ~/.config/systemd/user/t3code.service
[Unit]
Description=T3 Code
After=network-online.target

[Service]
ExecStart=/usr/bin/env npx t3@latest --port 3773 --host 127.0.0.1
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now t3code
loginctl enable-linger "$USER"   # run even with no active login session
```

(Adjust `ExecStart` to your Node/npx path — `which npx` — or install globally
with `npm i -g t3` and use `t3 --port 3773`.)

**Quick alternative (any OS)** — run it inside `tmux`/`screen`, or detach with:

```bash
nohup npx t3@latest >/tmp/t3code.log 2>&1 &
```

### 5. Enable notifications on your phone

Open the `https://…ts.net` URL, tap the **bell** in the top bar, and choose
**Enable notifications**. On Android, add the site to your home screen first for
the most reliable delivery. You'll get a push when an agent finishes or needs
approval — even with the tab closed.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
