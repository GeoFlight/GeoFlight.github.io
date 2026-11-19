# GeoFlight

GeoFlight is a browser-based, 1:1 Earth flight simulator built with Cesium. Choose any point on the globe, spawn a jet above the terrain, and fly from its 3D cockpit by default; switch to a chase view any time to inspect the aircraft.

## Run it

Serve this folder with any static web server, then open `index.html` through that server. For example, with Node.js installed:

```powershell
npx serve .
```

The Cesium token in `game.js` must permit the URL where the game is hosted. Replace it with your own restricted Cesium ion token before deploying publicly.

## Multiplayer

The game starts in single-player mode. To enable multiplayer, deploy the
WebSocket relay in `server/` to Render using the steps in `server/README.md`,
then set `MULTIPLAYER_URL` near the top of `game.js` to your service's
`wss://` URL and publish the updated game.

Leave `MULTIPLAYER_URL` as `""` to run single-player with no network.

Before you spawn, red dots on the globe show where every other pilot
currently is. In flight, other aircraft render as tinted models with a callsign
label, and the 3D Cesium globe in the top-left corner shows your position,
heading, and nearby pilots.

## Controls

| Control | Action |
| --- | --- |
| `W` / `S` | Pitch up / down; hold for a full loop |
| `A` / `D` or Left / Right arrows | Bank and turn; hold for a full roll |
| `Q` | Perform a controlled 180° turn |
| Hold `X` | Smoothly level the aircraft |
| `Shift`, Up arrow, or `I` | Increase throttle |
| `Ctrl`, Down arrow, or `K` | Reduce throttle and brake; use briefly in a bank for a tighter airbrake turn |
| `R` | Reset to the selected spawn point |
| `V` | Switch between the cockpit and chase camera |
| Left click or hold | Fire guns; sustained fire overheats them, then they cool down |
| Aim at an enemy for 3 seconds, then `F` | Lock and launch a missile |
| `C` | Deploy a flare to decoy incoming missiles |
| `[` / `]` | Nudge the model's nose alignment (debug) |
| Right-drag | Look around from the cockpit |
| `Esc` | Open or close in-flight settings; the online flight keeps running |
| Full screen button | Enter or exit fullscreen |

The aircraft retains its pitch and bank after you release the controls. Hold `X` to smoothly return to level flight, or use the opposite key for manual corrections. Press `Q` for a controlled 180° reversal; hard banks use moderate assisted combat turning. Fly from the 3D cockpit and right-drag to look around; press `V` to switch to a chase view, where you can inspect the exterior aircraft. Remote pilots always see the exterior model. Use in-flight Settings to change steering and camera sensitivity or field of view. The settings overlay does not pause the online simulation. Leave Flight returns to spawn selection. Settings are saved in this browser.

Gun rounds use bright fireball sprites and glowing trails, inherit the aircraft's velocity, and drop under gravity. A quick click fires at least one round; holding the button fires a stream. Rounds despawn after traveling 12 km. Multiplayer pilots also see the same visible bullets, missiles, and flares. The gun HUD below the crosshair is just the heat bar.

Keep an enemy within the aiming reticle for 3 seconds to lock on. The crosshair turns red while tracking, beeps and stays red when the lock is ready; press `F` to launch. Missiles home toward their locked target and appear to other pilots. Press `C` to drop a flare; a nearby flare can pull an incoming missile off course. All players are opponents in free-for-all combat and use the same aircraft model. The circular flight radar is a 3D Cesium globe centered on your position, with your heading shown as a blue arrow and enemy pilots as red arrows.

The speed readout is Mach; hold `Shift` to accelerate toward Mach 10, with throttle reaching full in about one second. Gun fire has mild leading aim assistance near an enemy reticle, while missile tracking accepts a target in a wider 24-degree cone and beeps after a 3-second continuous track. The minimap uses a blue heading arrow for you and red heading arrows for enemies.

Your aircraft has 100 hull. Gun hits deal 12 damage and missile hits deal 40; the HULL display shows your remaining health. At 40 hull or lower, dark smoke trails from your aircraft. A lethal hit or ground impact explodes your plane, shows a brief destruction screen, then returns you to spawn selection. In multiplayer, every connected pilot is an opponent.

## Credits

F-15C Eagle (USA) model by 42manako, licensed CC-BY-NC 4.0 via [Sketchfab](https://sketchfab.com/3d-models/f-15c-eagle-usa-2ba8289816584e97875c3a8e058108b5). Non-commercial use only.
