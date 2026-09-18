# Rename

A two-phone app for Abodh and Amruta to find a new first name for their son. Plain HTML/CSS/JS,
no build step, installed to the iPhone Home Screen from GitHub Pages.

## What it does

- **Discover** — a swipe deck. Swipe left = next name (skip for now), swipe right = bring back the previous card, tap = the name's full story. The ✕ ♥ ★ buttons record pass / like / love.
  After a swipe a quick "why?" sheet appears; the chips you tap teach the ranker what you care about.
- **Shortlist** — Both ♥ (names you both liked), Mine, Amruta's/Abodh's, Loved, Passed.
- **Face-off** — two shortlisted names at a time; an Elo rating turns your picks into standings.
- **Taste** — what each of you leans toward (syllables, endings, sounds, themes), and
  **Ask Claude for more**: Claude reads both people's swipes and reasons and invents 20 new names in
  that direction, scored against real US Social Security counts.
- **Settings** — who owns the phone, accent colour, filters (max syllables, min ease, hide coined,
  hide better-known), sync token, Claude key, backup.

## How names are ranked

Every name carries `unique` (from SSA national data: how many US boys got the name in 2024 —
100 means fewer than 5), `sayability` (1–10 from the generator, ×10), and `fresh`
(coined > rare-traditional > traditional). The deck order is
`0.34·unique + 0.34·sayability + 0.12·fresh + learned taste + partner boost + jitter`, with
category diversity so three of the same kind never sit in a row. The taste model
(`learn.js`) is a tiny logistic regression over explainable features, retrained from the full vote
history on every swipe.

## Data

- `data/names.json` — the pool. Built by `tools/build_pool.py` from the bucket files Claude Code
  generated (nature, virtues, epics, marathi, sky/music/knowledge, light/sound/art/spirit, short,
  coined) minus three exclusion lists (older-generation names, currently trending Indian-American
  names, South-Indian-specific names) and anything with 80+ US boys in 2024.
- `data/ssa.json` — 2024 SSA counts for every boy's name, so Claude's new suggestions get a real
  uniqueness score on the phone.
- Votes live per phone in `localStorage` (`rename.*`) and sync through the **private** repo
  `AbodhGawande/rename-data` (`votes-abodh.json`, `votes-amruta.json`, `extra-names.json`,
  `stories.json`). Each person writes only their own votes file, so the two phones never conflict.

## Deploying

1. Edit, then bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` (same number).
2. Commit and push `main`. GitHub Pages redeploys in about a minute; installed phones pick up the
   new version on the next launch (the service worker reloads once).

## Regenerating the pool

Run the bucket agents again (prompts are in the session that built v1, or ask Claude Code for
"another 130 names for bucket X"), drop the JSON files into a folder with `exclusions.json` and
`ssa_boys.json`, then `python3 tools/build_pool.py <that folder>`.

## Privacy

This repo is public only because GitHub Pages on a free plan requires it. It holds code and the
name pool — never votes, notes, tokens or keys. Secrets are pasted into the app's Settings and stay
in that phone's storage.
