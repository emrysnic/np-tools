# np-tools

Small Bun/TypeScript helpers for Neptune's Pride / Iron Helmet.

## Export messages and events

This tool logs into the current `np4.ironhelmet.com` account system, then downloads a game's diplomacy messages and event feed from the authenticated game endpoints.

### Environment

- `NP_USER` — account email / login alias
- `NP_PASSWD` — account password
- `GAME_ID` — game number to export
- `NP_BASE_URL` — optional base URL, defaults to `https://np4.ironhelmet.com`
- `NP_PAGE_SIZE` — optional page size for pagination, defaults to `100`
- `NP_OUTPUT_DIR` — optional output directory, defaults to the current directory

### Usage

```bash
bun run src/index.ts
```

Or provide the game id as a positional argument:

```bash
bun run src/index.ts 12345
```

### Output

The exporter writes:

- `<user>.<gameid>.messages.jsonl`
- `<user>.<gameid>.events.jsonl`

Message exports include fetched comments under a `comments` field.
