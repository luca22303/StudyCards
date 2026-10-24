# StudyCards

Personal flashcards for the phone and the MacBook. You can study by flipping cards or by typing your answer, with spaced repetition. Cards are synced through this GitHub repository, and the app is served by GitHub Pages.

- **Classes hold cards.** You add cards straight to a class. If you want to, you can split a class into lectures and study one lecture, or the whole class shuffled.
- **Two session types:**
  - **Review** shows cards that are due under spaced repetition, plus up to *N* new cards per day.
  - **Cram** shows every card of a lecture or class, shuffled, and never changes the schedule.
- **Two modes:**
  - **Flip cards:** tap or press Space to flip.
  - **Type answer:** type your answer, then compare it with the back of the card.
- After each card you rate yourself **Again / Hard / Good / Easy**. Again brings the card back at the end of the session.
- Both sides of a card support Markdown and images. On the phone, the image button also offers the camera. Images are shrunk to at most 1600 px before upload.
- **Paste cards:** create many cards at once, one per line, either as `front ;; back` or as two columns copied from Excel, Numbers or Google Sheets. With columns, any extra column (for example an example sentence) is added to the back.
- The app works offline and can be installed. Changes are queued on the device and synced when you are back online.

## Setup

1. **Enable GitHub Pages.** In the repository, open Settings → Pages. Set Source to *Deploy from a branch*, choose the branch, and choose `/ (root)`. The app is then at `https://<user>.github.io/StudyCards/`.
2. **Create a token.** Open [GitHub → Settings → Developer settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
   - Repository access: *Only select repositories* → `StudyCards`.
   - Permissions: *Contents → Read and write*.
3. **Enter the token on each device.** Open the app, tap ⚙︎, paste the token and press Save. On the hosted app, the owner and repository are detected from the URL.
4. **Install it.**
   - iPhone: in Safari, Share → *Add to Home Screen*.
   - Mac: in Safari, File → *Add to Dock*. In Chrome, use the install icon in the address bar.

The token is stored only in the browser on that device. **The repository is public, so your cards and images can be read by anyone.**

## How sync works

- Data lives in `data/` in the repository:

  | Path | Contents |
  |---|---|
  | `data/structure.json` | classes and lectures |
  | `data/cards/<lecture>.json` | the cards of one lecture. Cards added directly to a class go into a hidden lecture marked `isDefault` |
  | `data/reviews.json` | spaced-repetition state |
  | `data/img/` | images |

- Each sync makes **one commit**. The app first pulls what changed and merges it record by record, so the newer edit wins. Then it pushes.
- If the other device pushed in the meantime, GitHub rejects the update. The app then pulls again and retries, so neither device's edits are lost.
- Deleted cards stay in the files as `deleted: true`. Otherwise a stale device would bring them back.
- Each data commit also redeploys Pages. That is harmless, because the app reads data through the GitHub API, not from Pages.

## Spaced repetition

The app uses an SM-2 variant (see `js/lib/srs.js`). Intervals for a new card:

| Rating | Interval |
|---|---|
| Again | 1 day, and the card repeats in the current session |
| Hard | 1 day |
| Good | 1 day, then 3 days, then the previous interval × ease (starts at 2.5) |
| Easy | 4 days |

The interval each button would give is shown under it during a review.

A card counts as *mastered* once its interval reaches 21 days.

## Keyboard (Mac)

| Key | Action |
|---|---|
| Space | flip / reveal |
| 1–4 | Again / Hard / Good / Easy |
| Enter | in Type mode: check the answer (Shift+Enter inserts a line break) |
| ⌘+Enter | in the editor: save |

## Development

There is no build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

Tests:

```sh
node --test tests/*.test.mjs                     # unit tests: scheduling, merge, session, bulk parser
NODE_PATH=$(npm root -g) node tests/e2e.mjs      # end-to-end in Chromium (needs Playwright)
```

The end-to-end test drives the real app with two browser contexts, a "Mac" and an "iPhone", against an in-memory fake of the GitHub Git Data API. It covers:

- creating cards, bulk paste and image upload;
- flip and type sessions;
- that cram never changes the schedule;
- concurrent edits and deletes on both devices;
- a rejected push followed by a retry;
- offline use.

When you change a file of the app shell, bump `VERSION` in `sw.js`, so installed copies pick up the new version.

The vendored libraries are [marked](https://github.com/markedjs/marked) 12.0.2 (MIT) and [DOMPurify](https://github.com/cure53/DOMPurify) 3.1.6 (Apache-2.0 / MPL-2.0). Their licenses are in `vendor/`.
