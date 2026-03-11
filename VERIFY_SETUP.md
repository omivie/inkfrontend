# Setup Verification Prompt

Paste everything below into a new Claude Code session:

---

Run these verification checks for the config cleanup we just did. Do them all, report pass/fail for each.

## 1. Hook test (JS syntax check)
- Add `const x = ;` to the end of `inkcartridges/js/config.js`
- Confirm the PostToolUse hook fires and catches the syntax error
- Remove the bad line
- Edit a `.css` file (e.g. add a blank line to `base.css`) and confirm the hook does NOT fire
- Clean up

## 2. .claudeignore test
- Search for any `.png` or `.jpg` file — confirm zero results from Glob/Grep
- Search for anything in `node_modules/` — confirm zero results
- Search for a known `.js` file (e.g. `config.js`) — confirm it IS found

## 3. MCP servers
- Run `claude mcp list` or check `~/.claude.json` to confirm `supabase` and `github` MCP servers are registered
- Try calling a Supabase MCP tool (e.g. list tables) — if it prompts for OAuth, tell me to authenticate in browser
- Try calling a GitHub MCP tool (e.g. list repo issues) — same

## 4. Settings check
- Read `.claude/settings.local.json` and confirm:
  - ~30 permission entries (not 150+)
  - All 18 Playwright tools are listed
  - PostToolUse hook is defined with `node --check` command

## 5. File accuracy check
- Count JS files: `inkcartridges/js/**/*.js` — should be ~83
- Count CSS files: `inkcartridges/css/**/*.css` — should be 8
- Count HTML files: `inkcartridges/html/**/*.html` — should be ~42
- Confirm these match what CLAUDE.md says

Report a summary table at the end with pass/fail for each check.
