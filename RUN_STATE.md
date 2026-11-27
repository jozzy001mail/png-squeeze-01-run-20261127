# RUN_STATE — png-squeeze-01-run-20261127

- Slug: png-squeeze-01-run-20261127
- Competition: "Squeeze screenshots into the smallest PNG", $100 total over 50 places (1st–10th $4 each)
- Deadline: 2026-11-29T05:00:00Z
- Account: @jozzy-001; payout wallet sq8Mj2KhKLz6k5ftqgPmEDfUQ4RiqvcRMuQ2yY3Fu8Z
- Anchor (kit init, first action in session, before any file write): makefun anchor 938fa9fa3cf590c2305d7746a137853c63a0196c round 34319622
- Repo: https://github.com/jozzy001mail/png-squeeze-01-run-20261127
- HEAD commit: (filled after push below)

## What was built
`main.ts` (Node 22, plain JS/erasable TS, only node builtins) — lossless PNG
re-encoder written from scratch in this session:
- Decodes the stored RGBA PNG (generic unfilter), analyses opaque/grey/
  <=256-colours/single-transparent-key.
- Tries lossless forms: palette by count, by luminance, by greedy
  nearest-neighbour order; grey / grey+alpha / RGB / RGBA with tRNS key
  where possible.
- Per-row filters: fixed 0–4, min-sum, fewest-pairs, entropy; plus
  brute-force (deflate level 4 with 32 KiB dictionary) for the best-screened
  form. Candidates screened with zlib level 6; best three re-encoded at
  zlib level 9 (default + filtered strategies); smallest kept.
- Deterministic: fixed work per image, no clock/environment reads.
- Revisions in-session: v1 (screening + level-9 top-2) → v2 (+brute for best
  form, +fixed palette filters) → v3 (+entropy filter choice; never won
  screening, sizes unchanged) → fix: PNG signature bytes were missing from
  the writer (caught by the kit scorer, 0 points on first scorer run) →
  fixed and re-scored.

## Verification (practice set, kit's own scorer)
- Official scorer (`program/scorer/score.ts` on practice/reference):
  score **703,052**, passed **1**, answered **8/8**, every instance exact.
  Per-instance: i001 718.37 (12,496 B), i002 700.44 (52,273 B),
  i003 665.04 (108,156 B), i004 692.44 (106,248 B), i005 742.29 (16,551 B),
  i006 689.89 (178,840 B), i007 701.87 (60,890 B), i008 714.08 (24,900 B).
- House baseline fixed-paeth 1.0.0 scored on the same practice set:
  **420,399** — this entry beats it by 282,653. (Reference earns ~760–790;
  this entry is below the reference, mainly on rich/grey photo-like rows
  where the reference's optimal-parse deflate beats zlib level 9.)
- Determinism: two full runs byte-identical on all 8 outputs (cmp clean).
- Runtime: ~20 s for the 8-image set locally (wall budget 60 s).
- Repo size: main.ts + package.json + LICENSE + RUN_STATE.md, well under
  the 1 MiB repo cap.

## Blockers
- None. Build-only run: NOT bundled, NOT checked-with-transcripts,
  NOT submitted (no go-ahead for this run).

## Resume steps (parent, after Owoade's go-ahead)
1. `cd ~/workspace/makefun/png-squeeze-01-run-20261127-kit`
2. Bundle transcripts: `node cli/makefun.mjs bundle --repo ~/workspace/makefun/png-squeeze-01-run-20261127 --system-prompt ~/workspace/system/system_prompt.md --effort <level> --out transcripts.tar.gz --redact "<personal details>" --prompt-file ~/workspace/makefun/png-squeeze-01-run-20261127-prompt.txt` (adjust flags per bundle --help; include --muse-usage as the kit requires for Muse app sessions).
3. Check: `node cli/makefun.mjs check --kit . --repo ~/workspace/makefun/png-squeeze-01-run-20261127 --transcripts transcripts.tar.gz`
4. Set repo About (website https://make.fun, topic `makefun`) if not already set.
5. Submit: `node cli/makefun.mjs submit --competition png-squeeze-01-run-20261127 --repo-url https://github.com/jozzy001mail/png-squeeze-01-run-20261127 --commit <HEAD sha> --title "PNG squeeze: palette + brute-filter re-encoder" --bundle transcripts.tar.gz --keypair ~/workspace/makefun/makefun-keypair.json`
6. Verify live status: `node cli/makefun.mjs status --submission <id>` — report submission id and stage; do not report as verified until the live status page shows accepted.
