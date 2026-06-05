# Mode-B detection

Mode B = scaffolding a new program inside an **existing** pgas
consumer. Mode A = scaffolding a brand-new consumer repo (which
internally invokes Mode B for the bootstrap program).

Per the plugin's locked architectural decision #1, Mode B is the
first-class case. This doc specifies how `/pgas-new-program` detects
where to wire the new program in.

## Detection algorithm

```
1. Confirm CWD is a pgas consumer.
   ├── exists(package.json) → continue
   └── package.json depends on any @simodelne/pgas-* → continue
   Otherwise: abort with "Not in a pgas consumer."

2. Scan for marker comments (see MARKER-PROTOCOL.md).
   ├── For each marker found in server/ or src/:
   │     → inject above that line, no AskUserQuestion needed
   └── For markers NOT found: enter the candidate-file flow.

3. Candidate-file flow (when a marker is missing):
   ├── Run candidate ranking (see "Candidate ranking" below)
   ├── Show top 3 candidates to the user via AskUserQuestion
   ├── Ask follow-up for the line range
   └── Inject at the user-chosen site

4. Diff-and-confirm.
   ├── Build a single combined patch
   ├── Show as a unified diff
   ├── Ask "apply this patch? (yes/no)"
   └── Only proceed on explicit yes
```

## Candidate ranking

When a marker is absent, the plugin ranks candidate files this way:

### Tier 1 — files importing `@simodelne/pgas-server`

```bash
grep -rln "import.*@simodelne/pgas-server" --include="*.ts" server src
```

These files are the most likely registration sites. Rank by:

1. Whether the file ALSO contains a `ProgramRegistry` instance
   construction or use (`new ProgramRegistry`, `registry.register`).
2. Whether the file is named `index.ts` or `server.ts` or `main.ts`.
3. File size — smaller files (likely bootstraps) outrank larger files.

### Tier 2 — files containing `createDeclarativeSession` or `loadSpec`

```bash
grep -rln "createDeclarativeSession\|loadSpec\|loadSpecWithPatterns" --include="*.ts" server src
```

These files are likely program-construction sites even when they don't
directly touch the registry.

### Tier 3 — files containing handler maps

```bash
grep -rln "^\s*const handlers\s*[:=]\|^\s*handlers\s*:\s*{" --include="*.ts" programs src
```

These files are likely existing program handlers; the user MAY want
to merge into them.

### Fallback — `programs/` directory presence

If `programs/` exists but no Tier 1-3 file references it, ASK the
user where to place the new program directory directly.

## The diff-and-confirm flow

The plugin builds a unified diff combining:

1. New files copied from `templates/new-program/`.
2. Insertions above markers (or at user-chosen sites).

The diff is shown to the user. The user MUST reply "yes" (or "apply")
to proceed. Any other reply aborts cleanly — no files written, no
side effects.

## Worked example

Suppose the consumer has:

```
my-consumer/
├── package.json (depends on @simodelne/pgas-server@^1.13.0)
├── server/
│   └── index.ts (imports @simodelne/pgas-server, ProgramRegistry)
└── programs/
    └── (empty)
```

Running `/pgas-new-program first-program`:

1. ✓ package.json depends on pgas → continue
2. ✗ No `// [pgas-plugin:...]` markers in server/index.ts
3. Candidate ranking → server/index.ts is the only Tier 1 hit
4. AskUserQuestion: "Wire the program in server/index.ts? Yes/No"
5. AskUserQuestion: "Show me line ranges containing existing program
   registrations or handler maps in server/index.ts" — user replies
   "lines 45-60 have the registry construction"
6. Build diff:
   - Copy templates/new-program/* → programs/first-program/
   - Inject `import` at server/index.ts line 1 (after existing imports)
   - Inject `registry.register('first-program', ...)` at line 60
7. Show diff
8. "Apply? (yes/no)"
9. On "yes" → write all files, run /pgas:spec-validate +
   /pgas:mode-entry-lint, print next steps
