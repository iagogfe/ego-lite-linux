# ego-lite-linux

**English** · [Português](README.pt-BR.md)

[![CI](https://github.com/iagogfe/ego-lite-linux/actions/workflows/ci.yml/badge.svg)](https://github.com/iagogfe/ego-lite-linux/actions/workflows/ci.yml)
[![Security](https://github.com/iagogfe/ego-lite-linux/actions/workflows/security.yml/badge.svg)](https://github.com/iagogfe/ego-lite-linux/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iagogfe/ego-lite-linux/badge)](https://scorecard.dev/viewer/?uri=github.com/iagogfe/ego-lite-linux)
[![License](https://img.shields.io/github/license/iagogfe/ego-lite-linux)](LICENSE)

An unofficial Linux/WSL host for [ego lite](https://github.com/citrolabs/ego-lite), the browser where you and your AI agents work in parallel.

ego lite ships as a macOS app. This repository keeps the upstream `ego-browser` skill and harness intact and adds `package/ego-linux-host`: a long-lived Chromium supervisor plus a CLI shim, so agents can run the same `ego-browser` heredocs against a shared browser on stock Chromium.

> Not affiliated with CitroLabs. This is a community port that approximates the ego product model on Linux — it is **not** the ego lite app, and it does not replace it on macOS.

## What it gives you

| | |
|---|---|
| **Same agent interface** | Agents keep writing `ego-browser` JavaScript heredocs — snapshot, click, fill, wait, navigate, capture. No new API to learn. |
| **One shared browser** | A daemon supervises a single Chromium with your profile, so logins carry over instead of living in a throwaway automation profile. |
| **Task Spaces on stock Chromium** | Spaces are modelled as tab sets with ownership, so an agent's tabs stay separate from yours, and you can take a Space over mid-task. |
| **CDP only** | No kernel patches, no forked browser build. Chrome or Chromium from your distro is enough. |

## Requirements

- Linux, or WSL with a Linux-side Chrome/Chromium
- Node.js ≥ 22
- Chrome/Chromium for a live browser (unit tests run without it)

## Install

```bash
git clone https://github.com/iagogfe/ego-lite-linux.git
cd ego-lite-linux
bash skills/ego-browser/scripts/install-linux.sh
export PATH="$HOME/.local/bin:$PATH"
ego-browser --doctor
```

The installer builds the harness and the host, symlinks `ego-browser` into `~/.local/bin`, creates the data directories, detects Chrome, and runs the diagnostics.

Do **not** run `skills/ego-browser/scripts/install.sh` here — that is the upstream macOS path and it expects the ego lite DMG.

Headed mode wants a display (WSLg or native `DISPLAY`); otherwise set `EGO_HEADLESS=1`. For a non-standard browser, set `EGO_CHROME_PATH=/path/to/chrome`. With no browser installed at all, `--doctor` still answers and reports `chromeError` telling you so.

Full install notes and troubleshooting: [`skills/ego-browser/references/install.md`](skills/ego-browser/references/install.md) (section **Install steps (Linux / WSL)**).

## Usage

Point your agent CLI at the task in plain language, same as upstream:

```
ego-browser open example.com and tell me the page title
```

The agent picks up the `ego-browser` skill, opens the page in its own Space, reads a Snapshot, acts on the page, and reports back, while your own tabs stay untouched.

## Status

MVP. The daemon, CDP bridge, Task Spaces, CLI shim, doctor diagnostics, stale-socket recovery, and Chrome respawn all work, and the manual acceptance checklist passes on headed Linux Chrome. Treat it as early software: the surface is smaller than the macOS app, and the profile-seeding path is off by default because it can corrupt a live Chrome profile.

Details and internals: [`package/ego-linux-host/README.md`](package/ego-linux-host/README.md).
Design spec: [`docs/superpowers/specs/2026-07-23-ego-linux-host-design.md`](docs/superpowers/specs/2026-07-23-ego-linux-host-design.md).

## How it differs from upstream

| | upstream `citrolabs/ego-lite` | this repo |
|---|---|---|
| Platform | macOS app (`.dmg`) | Linux / WSL |
| Browser | ego lite, a customized Chromium build | stock Chrome/Chromium over CDP |
| Snapshot quality | kernel-level customization | accessibility tree over CDP |
| Distribution | download + `npx skills add citrolabs/ego-lite` | clone + `install-linux.sh` |

Everything under `package/ego-browser` and `skills/ego-browser` tracks upstream, minus the workflow that publishes the skill (and its guard test) — this fork publishes nothing. The Linux-specific work lives in `package/ego-linux-host` and `skills/ego-browser/scripts/install-linux.sh`.

## Development

```bash
cd package/ego-linux-host
npm ci
npm test        # build + typecheck + node --test, Chrome-free
./scripts/smoke.sh   # end-to-end, needs Chrome + a display (or EGO_HEADLESS=1)
```

CI runs the `package/ego-browser` and `package/ego-linux-host` suites on every push and pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Built on [ego lite](https://github.com/citrolabs/ego-lite) by [CitroLabs](https://github.com/citrolabs) — the `ego-browser` harness, the agent skill, and the Space model are theirs. For the macOS app, the docs, and the community, go to the upstream project:

- [lite.ego.app/document/](https://lite.ego.app/document/) — docs
- [Discord](https://discord.gg/5eGZVvHbTq) · [GitHub Discussions](https://github.com/citrolabs/ego-lite/discussions)

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), same as upstream.
