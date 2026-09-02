# PolyFlight

A browser-based, 1:1-Earth flight simulator prototype built on **CesiumJS**.

This is the **initial playable prototype**: interactive globe → pick a spawn point →
fly a low-poly jet with basic keyboard flight controls. No multiplayer or combat yet —
see [Roadmap](#roadmap) for what's next.

## Play flow

1. Open the site — a real 3D Earth loads, viewed from space.
2. Drag to rotate, scroll to zoom, click anywhere on the globe to drop a spawn marker.
3. Coordinates of the click appear in the panel; **START FLIGHT** becomes enabled.
4. Click **START FLIGHT** — the aircraft spawns just above the terrain at that point,
   and the camera switches to a third-person chase view.
5. Fly. Press **R** at any time to reset back to the spawn point.

## Controls

| Key | Action |
|---|---|
| W / S | Pitch down / up |
| A / D | Roll left / right |
| Q / E, or ← / →, or J / L | Yaw left / right |
| Shift, or ↑, or I | Increase throttle |
| Ctrl, or ↓, or K | Decrease throttle |
| Space | Climb / increase throttle |
| R | Reset to spawn point |

Arrow keys and I/J/K/L are alternate throttle/turn schemes for players who'd
rather keep a hand free of W/S/A/D/Q/E, or whose keyboard has no arrow keys.

## Setup — Cesium ion token

This project needs a **Cesium ion** access token to load World Terrain.
A token is already set in `game.js` — before deploying, double-check in your
[ion.cesium.com](https://ion.cesium.com) dashboard that it's scoped to
**`assets:read` only** and that its **Allowed URLs** are restricted to your
actual GitHub Pages origin (e.g. `https://<your-username>.github.io`), since
this token ships visible in the frontend JS by design (that's what Allowed
URLs + `assets:read`-only scoping are for).

To swap in a different token later, edit the `CESIUM_ION_TOKEN` constant near
the top of `game.js`.

Do not commit a token with broader scopes, and never put a Render/server-side
multiplayer secret in this frontend file — this project stays 100% static/browser-only.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo's **Settings → Pages**, set the source to the branch/root containing
   `index.html`.
3. Make sure the Cesium ion token's Allowed URLs include the resulting
   `https://<username>.github.io/<repo>/` origin.
4. Visit the published URL.

No build step is required — it's plain HTML/CSS/JS plus the CesiumJS CDN build.

## Project structure

```text
PolyFlight/
│
├── index.html          start screen + HUD markup, loads CesiumJS from CDN
├── style.css            HUD / start-screen styling
├── game.js               all game logic (see "Architecture" below)
├── README.md
│
└── assets/
    └── planes/
        └── jet.glb      aircraft model
```

## Architecture

`game.js` is deliberately split into single-purpose pieces so multiplayer can be
added later without restructuring everything:

- **`CesiumWorld`** — owns the Cesium `Viewer`, terrain provider, base camera framing.
- **`SpawnSelector`** — start-screen click-to-pick UX and the spawn marker.
- **`PlayerState`** — a plain-data object (`longitude`, `latitude`, `height`,
  `heading`, `pitch`, `roll`, `speed`). This is exactly the shape that will later be
  serialized to JSON and sent over a WebSocket to the planned Render-hosted
  multiplayer server, and the shape remote players' state will arrive in.
- **`Aircraft`** — renders a `PlayerState` onto a Cesium model `Entity`. A remote
  player will just be another `Aircraft` driven by network data instead of
  `FlightController`.
- **`FlightController`** — the only piece with "physics": turns held keys into
  a new `PlayerState` each frame. This is the piece to replace when real flight
  physics arrive.
- **`ChaseCamera`** — points the Cesium camera at an `Aircraft`'s `PlayerState`.
- **`HUD`** — renders a `PlayerState` into the on-screen readout.

Planned future data flow:

```text
GitHub Pages → CesiumJS → Browser → WebSocket → Render multiplayer server → other players
```

## Roadmap (not yet implemented)

- Multiplayer with real-time aircraft position sync (WebSocket, Render-hosted server)
- Air PvP, weapons, hitscan/projectiles, damage, health, respawning
- Multiple selectable aircraft
- Player names, server browser, multiple arenas/game modes
- Proper flight physics (lift/drag/stall model) replacing `FlightController`
- Cockpit camera option alongside the chase camera
- Higher-detail aircraft, possibly 3D buildings/photogrammetry
- Global racing/flight modes

## Credits

**Jet by jeremy** [CC-BY] via Poly Pizza
- https://poly.pizza/m/6fyLMORhgGK
- License: https://creativecommons.org/licenses/by/3.0/
