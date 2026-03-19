# pi-btw

A small [pi](https://github.com/badlogic/pi-mono) extension that adds a `/btw` command for asking quick side questions without interrupting the agent's current task.

## What it does

- adds a `/btw <question>` command
- answers with a separate model call using the current pi model
- includes recent conversation context with the side question
  - uses up to 1/4 of the active model's context window when available
  - falls back to a 60k-token context window if the model metadata is unavailable
  - estimates size using 3.5 characters per token and keeps the most recent context when truncating
- shows the result in a temporary widget above the editor
- keeps the side conversation out of the main agent context
- lets you dismiss the widget early with `Ctrl+Shift+B`

## Install

```bash
pi install https://github.com/tbroadley/pi-btw
```

This repository is structured as a pi package, so installing it from git will automatically load the extension.

## Usage

```text
/btw What does this error mean?
/btw How do async iterators work in TypeScript?
```

## Reloading after updates

If you already have `pi-btw` installed, pull the latest version into pi's package cache and then reload pi:

```bash
pi update https://github.com/tbroadley/pi-btw
```

After that finishes, run `/reload` in pi.
