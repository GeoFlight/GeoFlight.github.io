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
| Hold `X` | Smoothly level the aircraft |
| `Shift`, Up arrow, or `I` | Increase throttle |
| `Ctrl`, Down arrow, or `K` | Reduce throttle and brake; use briefly in a bank for a tighter airbrake turn |
| `R` | Reset to the selected spawn point |
| Space, left click, or `F` | Fire guns |
| Track an aircraft, then `M` | Lock and launch a missile |
| `C` | Deploy a flare to decoy incoming missiles |
| `[` / `]` | Nudge the model's nose alignment (debug) |
| Right-drag | Orbit the chase camera |
| Mouse wheel | Zoom the chase camera |
| `Esc` | Open the pause menu; choose Settings, Resume, or Leave Flight |
| Full screen button | Enter or exit fullscreen |

The aircraft retains its pitch and bank after you release the controls. Hold `X` to smoothly return to level flight, or use the opposite key for manual corrections. Steering is tuned for a more measured jet response; use the pause menu's Settings tab to change steering and camera sensitivity or field of view. Leave Flight returns to spawn selection. The elevated chase camera smoothly follows the aircraft and can be orbited or zoomed while flying. Settings are saved in this browser.

Gun rounds are rendered as 3D projectiles, inherit the aircraft's velocity, and drop under gravity. Tracer streaks appear periodically in the stream, and rounds despawn after traveling 2.5 km.

Keep another aircraft inside the center reticle until the weapon HUD shows a lock, then press `M` to launch. Missiles home toward their locked target and appear to other pilots. Press `C` to drop a flare; a nearby flare can pull an incoming missile off course. The weapon HUD shows your remaining missiles and flares.

## Credits

F-15C Eagle (USA) model by 42manako, licensed CC-BY-NC 4.0 via [Sketchfab](https://sketchfab.com/3d-models/f-15c-eagle-usa-2ba8289816584e97875c3a8e058108b5). Non-commercial use only.
