# GeoFlight

GeoFlight is a browser-based, 1:1 Earth flight simulator built with Cesium. Choose any point on the globe, spawn a jet above the terrain, and fly with a third-person chase camera.

## Run it

Serve this folder with any static web server, then open `index.html` through that server. For example, with Node.js installed:

```powershell
npx serve .
```

The Cesium token in `game.js` must permit the URL where the game is hosted. Replace it with your own restricted Cesium ion token before deploying publicly.

## Multiplayer

The `server/` folder holds a WebSocket relay meant for Render — see
`server/README.md` for the deploy settings. Once it's live, set
`MULTIPLAYER_URL` at the top of `game.js` to your `wss://` service URL.

Leave `MULTIPLAYER_URL` as `""` to run single-player with no network.

Before you spawn, red dots on the globe show where every other pilot
currently is. In flight, other aircraft render as tinted models with a callsign
label, and a minimap in the top-left corner shows your position on the globe
along with everyone else on your side of the planet.

## Controls

| Control | Action |
| --- | --- |
| `W` / `S` | Pitch up / down; hold for a full loop |
| `A` / `D` or Left / Right arrows | Bank and turn; hold for a full roll |
| `Shift`, Space, Up arrow, or `I` | Increase throttle |
| `Ctrl`, Down arrow, or `K` | Reduce throttle and brake; use briefly in a bank for a tighter airbrake turn |
| `R` | Reset to the selected spawn point |
| Left click or `F` | Fire guns |
| `[` / `]` | Nudge the model's nose alignment (debug) |

The aircraft retains its pitch and bank after you release the controls. Use the opposite key to roll or pitch back to the attitude you want. Roll, pitch, and banked turns are tuned for responsive high-G aerobatics, and the chase camera follows the nose through loops so you can see ahead. The aircraft lighting is brightened to keep its details visible against the terrain.

## Credits

F-15C Eagle (USA) model by 42manako, licensed CC-BY-NC 4.0 via [Sketchfab](https://sketchfab.com/3d-models/f-15c-eagle-usa-2ba8289816584e97875c3a8e058108b5). Non-commercial use only.
