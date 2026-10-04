# KnightClub Chess

A polished, Vercel-hostable chess club for live games with friends. Friends and preferences stay in each browser. Pusher Channels acts only as an ephemeral realtime relay; the project has **no database, no account system, and no durable inbox**.

## What’s included

- Direct, in-app friend requests and game challenges using a one-time friend code—no repeatedly shared match links.
- Legal-move highlights, click and drag moves, promotion choices, premoves, and cancel-premove. A queued premove stays visible until the move is actually committed, then it is executed or discarded with a notice.
- Clocks, takeback requests, draw offers, resign, rematch with swapped colors, and move replay.
- Checkmate explanation with arrows derived from the actual position: the checking lines are read from the board, not from a stored flag.
- Final results are agreed between the two clients. A snapshot that still says “active” while its board is checkmate, stalemate or a draw is corrected, stored, and echoed back to the sender, so both players see the same ending even when a relay event was missed or two versions collided.
- Light, dark, and “follow this device” appearance settings, applied before first paint so a dark reload never flashes white. Board coordinates, move-sound and notification toggles live next to it.
- Move sounds share a single resumed audio context that is unlocked on the first tap or key press, so the first relayed move is audible.
- Display name, friend code, and an optional browser-local lock, managed from the settings page.
- Responsive, installable PWA for Vercel/Next.js, with mobile install guidance, a dark-aware offline page, and a lightweight app-shell cache.

## Zero-database architecture and tradeoffs

- **Browser storage:** profile, friend list, and preferences are in `localStorage`. A current online game snapshot is kept in `sessionStorage` for that tab. There is no server-side player or game record.
- **Realtime:** Pusher Channels forwards private-channel client events and online presence. Vercel signs channel-authorization requests with an HMAC; it does not store app data.
- **Both players must be online:** friend requests, challenges, moves, and action requests are live-only. If the recipient is offline, nothing is queued.
- **No durable inbox, offline push, or saved match history.** Browser notifications can appear only while KnightClub is open and connected. The session-games list is temporary. The PWA caches the app shell/static assets for faster reloads and a basic offline fallback; online games and requests still need internet.
- **No account/password recovery.** The optional password is a browser-local lock only. Clearing browser data removes the profile, friends, settings, and lock.
- **Friend codes are bearer invites.** They are high-entropy and should be shared privately. Anyone who has a code can address that player's live inbox.
- The relay is not an authoritative chess server. Both clients validate moves locally and exchange snapshots over authorized private channels; this is intended for private casual games, not rated or cheat-resistant play. A reconnect can recover from the other player's open tab, but there is no server copy if both players lose their session.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Without Pusher credentials, KnightClub opens in local-only mode. You can play both colors on one board and try the chess controls. Add the configuration below for cross-device play.

## Install on a phone or desktop

Use the deployed HTTPS KnightClub URL (Vercel provides HTTPS). The app also shows a small **Install KnightClub** card with browser-specific steps when it is not already installed.

- **Android / Chrome:** open the site, tap the browser menu (`⋮`), then choose **Install app** or **Add to Home screen** and confirm. If Chrome offers an **Install** button in KnightClub, you can use that instead.
- **iPhone / iPad:** open the site in **Safari**, tap **Share**, choose **Add to Home Screen**, then tap **Add**. iOS does not show the same automatic install prompt as Chrome.
- **Desktop / Chrome or Edge:** use the install icon in the address bar, if shown, or choose **Install KnightClub** from the browser menu.

The installed shortcut opens in a standalone app-style window. It does not enable offline multiplayer, offline notifications, or durable storage; friend requests and online games still require both players to be connected.

## Configure Pusher Channels

1. Create a Pusher **Channels** app in the Pusher dashboard and note its key, secret, and cluster.
2. In the app settings, **enable client events**. KnightClub uses `client-` events on the random, authorized game channel for live board snapshots and rematch negotiation. Friend and challenge inbox events are sent through the Vercel route so only the recipient can subscribe to their inbox.
3. Put the values in `.env.local`:

   ```dotenv
   NEXT_PUBLIC_PUSHER_KEY=your_app_key
   NEXT_PUBLIC_PUSHER_CLUSTER=your_cluster
   PUSHER_APP_ID=your_app_id
   PUSHER_APP_KEY=your_app_key
   PUSHER_APP_SECRET=your_app_secret
   ```

   `NEXT_PUBLIC_PUSHER_KEY` and `PUSHER_APP_KEY` must be identical. Only the public key and cluster are exposed to the browser; **never** prefix `PUSHER_APP_SECRET` with `NEXT_PUBLIC_`.

4. Restart `npm run dev`. Open the app in two browsers/devices, exchange the friend code once, accept the friend request, and then challenge each other from the app.

The app uses presence to show which saved friends are online. A friend request or challenge can only be delivered while the other player is connected. Each browser subscribes only to its own private inbox. A small Vercel route verifies a short-lived HMAC made with the sender's local friend code, then asks Pusher to forward a live event; neither route stores the event. Game snapshots use Pusher client events on a random per-match channel.

## Deploy to Vercel

1. Push the project to a Git provider and import it in Vercel, or deploy with the Vercel CLI.
2. Add these environment variables in **Vercel → Project → Settings → Environment Variables**:
   - `NEXT_PUBLIC_PUSHER_KEY`
   - `NEXT_PUBLIC_PUSHER_CLUSTER`
   - `PUSHER_APP_ID`
   - `PUSHER_APP_KEY`
   - `PUSHER_APP_SECRET`
3. Confirm client events are enabled in the Pusher app, then deploy/redeploy. No database, schema migration, persistent custom server, or push-service setup is needed.

## Commands

```bash
npm run dev        # local development
npm run lint       # TypeScript check
npm test           # game-state and two-client relay tests
npm run test:watch # re-run the tests while editing
npm run build      # production build
npm start          # run the built app locally
npm audit          # dependency security audit
```

### Checking a live two-client game

Automated tests cover the relay rules with two simulated clients (see `tests/`), but a real check still needs two browsers:

1. Deploy (or run locally) with Pusher credentials, then open KnightClub in two browsers or two devices.
2. Exchange the friend codes once, accept the friend request, and start a game with a short clock.
3. Play to a real checkmate (Scholar's mate works: `e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#`). Both screens must show **Checkmate**, the same winner, the red checking arrows, the final-result card, and the rematch/replay controls.
4. Check the resilience paths: reload one tab mid-game (the restored snapshot is re-read from its board), background it during the mating move, and let a relay hiccup happen—the tab requests a fresh snapshot when it reconnects or wakes up.
5. Try a finish while the opponent is sending a draw offer or takeback at the same moment. Versions can collide; the final result still wins and both clients converge on the same version.

## Project structure

- `components/ChessClubApp.tsx` — app UI, browser-local data, chess interactions, and Pusher client.
- `components/ChessBoard.tsx` — interactive board, legal-move indicators, and checkmate arrows.
- `app/api/pusher/auth/route.ts` — Vercel-compatible HMAC auth for owner inbox, presence, and random match channels.
- `app/api/pusher/trigger/route.ts` — validates a short-lived sender-code signature and forwards an inbox event through Pusher without storing it.
- `lib/chess-state.ts` — pure game-state helpers: reading a result off a FEN, correcting stale snapshots, deciding whether a relayed snapshot is applied, and deriving checkmate marks.
- `lib/types.ts` — local and transient game types.
- `tests/chess-state.test.ts` — result inference, snapshot correction and relay-decision rules.
- `tests/two-client-sync.test.ts` — two simulated clients exchanging snapshots until they converge on the same final result.

There are deliberately no Supabase files, migrations, or database dependencies.
