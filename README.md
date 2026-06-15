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
- Enable **MagicDNS** and **HTTPS Certificates** once in the
  [Tailscale admin console](https://login.tailscale.com/admin/dns) (required for the
  HTTPS URL below).
- Authenticate at least one provider on the host (see [Installation](#installation)).

### 2. Run the server with Tailscale HTTPS

Notifications (Web Push) and other browser features require a **secure context**
(HTTPS). T3 Code can configure Tailscale Serve for you with `--tailscale-serve`:

```bash
npx t3@latest --tailscale-serve
```

This serves T3 Code at `https://<machine>.<tailnet>.ts.net` — open that URL from
any device on your tailnet. Useful flags (`npx t3@latest --help` for the full list):

- `--tailscale-serve` — front the server with Tailscale Serve over HTTPS
  (env: `T3CODE_TAILSCALE_SERVE=true`).
- `--tailscale-serve-port <number>` — HTTPS port (default `443`; env:
  `T3CODE_TAILSCALE_SERVE_PORT`).
- `--port <number>` — local server port (default `3773`).

> [!WARNING]
> Use Tailscale **Serve** (tailnet-private), not **Funnel** (public internet).

<details>
<summary>Prefer to manage Tailscale Serve yourself?</summary>

Run the server normally and proxy it manually:

```bash
npx t3@latest                  # listens on 127.0.0.1:3773
tailscale serve --bg 3773      # https://<machine>.<tailnet>.ts.net
tailscale serve status         # show the URL ( `tailscale serve reset` to stop )
```

</details>

### 3. Run your own build (from source)

`npx t3@latest` installs the published release. To run a checkout or fork (e.g.
with local changes), build and run from source instead:

```bash
git clone <your-fork-url> t3code && cd t3code

curl -fsSL https://vite.plus | bash   # installs the `vp` toolchain
vp i                                  # install dependencies
pnpm build                            # builds the web app + bundles the server

node apps/server/dist/bin.mjs --tailscale-serve
```

Keep the cloned repo **with its `node_modules`** in place — the bundle leaves some
dependencies external, so it runs from the checkout rather than as a standalone
file. Update later with `git pull && vp i && pnpm build`, then restart the server.

### 4. Keep it running in the background

**Linux (systemd user service)** — survives logout and starts on boot:

```ini
# ~/.config/systemd/user/t3code.service
[Unit]
Description=T3 Code
After=network-online.target

[Service]
WorkingDirectory=%h/projects
# Published release:
ExecStart=/usr/bin/env npx t3@latest --port 3773 --tailscale-serve
# ...or your own build — replace the line above with:
#   ExecStart=/usr/bin/env node %h/t3code/apps/server/dist/bin.mjs --port 3773 --tailscale-serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now t3code
loginctl enable-linger "$USER"   # run even with no active login session
```

`WorkingDirectory` is the folder T3 Code opens by default; you can also add
projects from the UI. Adjust the Node/npx path for your environment (`which node`).

**Quick alternative (any OS)** — run it inside `tmux`/`screen`, or detach with:

```bash
nohup npx t3@latest --tailscale-serve >/tmp/t3code.log 2>&1 &
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
