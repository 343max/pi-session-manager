# pi-session-picker

A [pi](https://pi.dev) extension that lets you pick from recent sessions and resume them in a new WezTerm tab.

## Install

Just clone this repo and start pi from its directory — pi auto-discovers extensions in `.pi/extensions/`.

```bash
git clone https://github.com/343max/pi-session-manager.git
cd pi-session-manager
pi --session-pick
```

Or install as a pi package:

```bash
pi install git:github.com/343max/pi-session-manager
```

## Usage

| Method | What it does |
|--------|-------------|
| `pi --session-pick` | Launch pi, immediately show the picker, spawns wezterm, then exits |
| `pi --session-pick-json` | Output last 20 sessions as JSON (for scripting) |
| `/session-pick` | Show the picker inside an already-running pi session |

All show your last 20 sessions sorted by recency, with name and working directory.

```bash
# Pipe to jq for scripting
pi --session-pick-json 2>&1 | jq '.[0].id'
```

Pick one from the interactive picker → a new WezTerm tab opens with `pi --session <id>` continuing that session.

## Requirements

- [pi](https://pi.dev) 
- [WezTerm](https://wezterm.org) terminal emulator
