# Configuration fixtures

- `v0.json` — a **synthetic** schema version 0 (Veydr never shipped one). Projects had `title`/`root` and no commands or settings. Used with a test-only `0 → 1` migration to exercise the migration framework.
- `v2.json` — a **synthetic** document from a hypothetical newer Veydr (schema version 2, extra fields). Loading it must leave it byte-identical and switch to read-only mode.
