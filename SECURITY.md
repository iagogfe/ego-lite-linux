# Security Policy

## Supported versions

This project is pre-1.0. Only the current `main` branch receives fixes.

| Version | Supported |
|---|---|
| `main` | ✅ |
| older commits / branches | ❌ |

Vulnerabilities in the upstream `ego-browser` harness, the agent skill, or the ego lite macOS app belong to [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) — report those there. Report here only what is specific to `package/ego-linux-host` or the Linux installer.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/iagogfe/ego-lite-linux/security/advisories/new) — do not open a public issue for a security bug.

Include what you did, what happened, and what you expected. Expect a first reply within 7 days. There is no bounty program.

## Threat model you are opting into

The host is designed to hand an AI agent a real browser that carries your real logins. That is the point of the tool, and it has consequences worth stating plainly:

- **The agent acts as you.** Any site you are logged into in the shared profile is reachable by an agent driving the browser. Task Spaces separate the agent's tabs from yours; they are not a security boundary against a hostile agent or a hostile page.
- **CDP is a local control plane.** Chrome is launched with `--remote-debugging-port` bound to `127.0.0.1` only, never `0.0.0.0`. Even so, any local process running as your user can speak CDP to that port and drive the browser. Do not run the host on a shared or multi-user machine.
- **Daemon socket.** The Unix socket and data directory are created with mode `0700` under `$XDG_DATA_HOME/ego-lite` (default `~/.local/share/ego-lite`), so they are limited to your user.
- **Page content is data, not instructions.** Snapshots and page text returned to the agent are untrusted input. A page can attempt prompt injection against whatever agent is reading it — the host does not and cannot sanitize that.
- **Profile seeding is off by default.** Copying an existing Chrome profile can corrupt a live one. It stays opt-in, and it should only be used with Chrome closed.
- **Downloads and file uploads** touch your real filesystem with your permissions.

If any of the above is a problem for your environment, run the host headless against a throwaway profile (`EGO_USER_DATA_DIR=/path/to/scratch`) instead of your daily browser.
