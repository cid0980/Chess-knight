# KnightClub Chess

A polished, Vercel-hostable chess club for live games with friends. Friends and preferences stay in each browser. Pusher Channels acts only as an ephemeral realtime relay; the project has **no database, no account system, and no durable inbox**.

## What’s included

- Direct, in-app friend requests and game challenges using a one-time friend code—no repeatedly shared match links.
- Legal-move highlights, click and drag moves, promotion choices, premoves, and cancel-premove.
- Clocks, takeback requests, draw offers, resign, rematch with swapped colors, and move replay.
- Checkmate explanation with arrows pointing from checking pieces toward the trapped king.
- Local board, sound, notification, display-name, and optional browser-lock settings.
- Responsive Vercel/Next.js app with a small signed-channel authorization route.

## Zero-database architecture and tradeoffs

- **Browser storage:** profile, friend list, and preferences are in `localStorage`. A current online game snapshot is kept in `sessionStorage` for that tab. There is no server-side player or game record.
- **Realtime:** Pusher Channels forwards private-channel client events and online presence. Vercel signs channel-authorization requests with an HMAC; it does not store app data.
- **Both players must be online:** friend requests, challenges, moves, and action requests are live-only. If the recipient is offline, nothing is queued.
- **No durable inbox, offline push, or saved match history.** Browser notifications can appear only while KnightClub is open and connected. The session-games list is temporary.
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
npm run dev      # local development
npm run lint     # TypeScript check
npm run build    # production build
npm start        # run the built app locally
npm audit        # dependency security audit
```

## Project structure

- `components/ChessClubApp.tsx` — app UI, browser-local data, chess interactions, and Pusher client.
- `components/ChessBoard.tsx` — interactive board, legal-move indicators, and checkmate arrows.
- `app/api/pusher/auth/route.ts` — Vercel-compatible HMAC auth for owner inbox, presence, and random match channels.
- `app/api/pusher/trigger/route.ts` — validates a short-lived sender-code signature and forwards an inbox event through Pusher without storing it.
- `lib/types.ts` — local and transient game types.

There are deliberately no Supabase files, migrations, or database dependencies.
