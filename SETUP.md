# Setting up Rename on a phone

Takes about three minutes per phone. Do Abodh's phone first, then Amruta's.

## 1. Install it on the Home Screen

1. Open **https://abodhgawande.github.io/rename/** in Safari.
2. Tap the Share button → **Add to Home Screen** → Add.
3. Open it from the Home Screen (it runs full-screen there). Pick who's holding the phone.

## 2. Connect the two phones (once, on each phone)

Votes travel through a private GitHub repo, `AbodhGawande/rename-data`. Each phone needs a token
that can write to that one repo — nothing else.

1. On any browser, signed in as AbodhGawande, open
   **https://github.com/settings/personal-access-tokens/new**
2. Token name: `Rename phones`. Expiration: **1 year** (custom date).
3. Repository access: **Only select repositories** → pick **rename-data**.
4. Permissions → Repository permissions → **Contents: Read and write**. Leave everything else alone.
5. Generate token, copy it (starts with `github_pat_`).
6. In the app: ⚙︎ Settings → **Sync** → paste the token → **Connect & sync**. It should say
   *Connected · synced just now*.
7. AirDrop or iMessage the same token to the other phone and repeat step 6 there.

From then on the app syncs on launch, whenever you come back to it, and a few seconds after each
swipe. The ↻ button at the top forces a sync.

## 3. Turn on Claude (optional but recommended)

⚙︎ Settings → **Claude** → paste the Anthropic API key (`sk-ant-…`). This unlocks
**Ask Claude for more** (Taste tab) and **Ask Claude about <name>** (inside any name's page).
The key stays in that phone's storage.

## Everyday use

- **Discover:** swipe right = like, left = pass, up = love (or use ✕ ♥ ★). ⏮ = previous name, ⏭ = skip for now. Tap the card for the full story.
  After a swipe, tap a reason or two — that's what trains the ranking.
- **Shortlist → Both ♥** is the list that matters. **Face-off** ranks it.
- Undo is the ↶ button. Skip (⏭) parks a name for later without judging it.
- **Backup:** Settings → Copy backup, paste into Notes. Deleting the app from the Home Screen
  deletes its local data (sync keeps a copy in the repo too).
