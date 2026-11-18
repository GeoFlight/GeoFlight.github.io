# GeoFlight multiplayer relay

## Deploy to Render

1. Push the project to a GitHub repository and create a Render account.
2. In Render, select **New + → Web Service** and connect the repository.
3. Configure the service:

   | Field | Value |
   | --- | --- |
   | Runtime | Node |
   | Root Directory | `server` |
   | Build Command | `npm ci` |
   | Start Command | `npm start` |

4. Choose a plan and deploy. Render supplies the `PORT` environment variable;
   the server listens on it automatically.
5. Open `https://your-service-name.onrender.com/`. A healthy service responds
   with JSON similar to `{"status":"ok","players":0}`.
6. In `game.js`, set `MULTIPLAYER_URL` to the secure WebSocket URL for your
   service, then publish the updated game:

   ```js
   const MULTIPLAYER_URL = "wss://your-service-name.onrender.com";
   ```

Use `wss://` for the WebSocket URL, not `ws://` or `https://`. GitHub Pages is
HTTPS and browsers block insecure WebSocket connections.

Free Render services may sleep when idle and take time to wake; the client
reconnects automatically.

## Test locally

```bash
cd server
npm install
npm start
```

Then set `MULTIPLAYER_URL` to `ws://localhost:8080` while testing locally.
Restore the Render `wss://` address before publishing the game.

The relay is an alpha implementation: it forwards player state and client
reported hits, so it is not cheat-resistant.
