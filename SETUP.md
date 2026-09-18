# Setting up Rename on a phone

Rename runs on the Mac mini at home. On the home Wi-Fi, open Safari and go to

    http://m2-mac-mini.local/rename/

(or http://192.168.1.106/rename/) → Share → **Add to Home Screen** → open it from there and pick who's
holding the phone. That's all: votes, Claude's work and the name pool live on the mini, so both phones see
the same thing within a few seconds and nothing needs pasting.

Away from home the app can't reach the mini (it opens but shows "Not reachable"); Tailscale can fix that
later if you want it.

## Everyday use

- **Discover:** swipe right = like, left = pass, up = love (or use ✕ ♥ ★). ⏮ = previous name, ⏭ = skip for now. Tap the card for the full story.
  After a swipe, tap a reason or two — that's what trains the ranking.
- **Shortlist → Both ♥** is the list that matters. **Face-off** ranks it. **+ Add** puts in a name you found yourselves.
- **Generate 100 new names** (Taste tab, or the end-of-list card) runs on the mini: close the app if you like; the
  names appear as each batch lands (10–15 minutes for a full run, each name quality-checked).
- **Backup:** the mini keeps a nightly copy of everything (`~/Apps/rename/backups`). Settings → Copy backup still
  works for a paste-into-Notes copy.

## For Abodh: updating the app

Edit in `~/Documents/Claude/rename/`, then `python3 tools/stamp.py` and
`~/Documents/Claude/mini-server/scripts/deploy.sh rename`. Phones pick it up on the next open.
