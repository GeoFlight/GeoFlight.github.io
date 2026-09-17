# GeoFlight multiplayer relay

Deploy this folder to Render as a **Web Service** (not a Static Site).

## Render setup

| Field | Value |
| --- | --- |
| Environment | Node |
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |

Render provides the port via `PORT` — don't hardcode one.

Once deployed, copy your service URL and put it in `game.js`:

```js
const MULTIPLAYER_URL = "wss://your-service-name.onrender.com";
```

It must be `wss://`, not `ws://` or `https://`. GitHub Pages serves over
HTTPS and browsers block insecure sockets from a secure page.

## Free tier note

Free Render services sleep after ~15 minutes idle and take 30–60 seconds to
wake. The client reconnects automatically with backoff, so the first player to
join may see `RECONNECTING` for a bit before `ONLINE`.

## Test locally

```bash
cd server
npm install
npm start
```

Then set `MULTIPLAYER_URL = "ws://localhost:8080"` while testing locally.
