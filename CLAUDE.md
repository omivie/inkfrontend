# CLAUDE.md

Project instructions for Claude Code in this repo (InkCartridges.co.nz).

## 🚨 Before anything else, on EVERY task

Before starting work on **any** task or prompt in this repo — before reading files,
searching, planning, or editing — run **both** of these plugins:

1. **caveman** — `Skill(caveman:caveman)` (or `/caveman`)
2. **ponytail** — `Skill(ponytail:ponytail)` (or `/ponytail`)

Run them in that order, on every prompt, no exceptions. This applies to one-line
questions and small edits too, not just large tasks.

Both are installed at **user scope** from their own GitHub marketplaces
(`JuliusBrussee/caveman` v2.7.0, `DietrichGebert/ponytail` v4.10.0). Each also
registers `SessionStart` + `UserPromptSubmit` hooks, so they self-activate — the
rule above is the backstop for when a hook does not fire, and for the manual
`/caveman-*` and `/ponytail-*` commands.

If either plugin is **not available** in the session (uninstalled, disabled, or the
skill name does not resolve), say so explicitly in the reply and stop to ask — do
not silently proceed without it. **A skip is not a pass.**

### Where they conflict with this repo

caveman compresses prose; ponytail pushes for the shortest thing that works. This
repo's conventions pull the other way in three specific places, and those win:

- **Fail-soft must be LOUD** — partial-ness belongs in the return value and the UI.
  Do not let compression drop a provenance flag or a partial-data warning.
- **Probes state their mode and own their safety** — a probe's READ-ONLY/recording
  banner, its negative control, and its rollback are not boilerplate to trim.
- **Report measurements, not intentions** — a shortened claim must still say what
  was measured, not what was meant.
