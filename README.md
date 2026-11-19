# GeoFlight

GeoFlight is a browser-based, 1:1 Earth flight simulator built with Cesium. Explore the globe alone or join a free-for-all in a selected country. Choose a spawn point on the globe, start 800 m above terrain, and fly from the separate 3D cockpit by default; switch to a chase view any time to inspect the aircraft.

## Run it

Serve this folder with any static web server, then open `index.html` through that server. For example, with Node.js installed:

```powershell
npx serve .
```

The Cesium token in `game.js` must permit the URL where the game is hosted. Replace it with your own restricted Cesium ion token before deploying publicly.

## Multiplayer

The main menu offers Single Player globe exploration and Multiplayer. Multiplayer
is organized into country-specific lobbies: choose any country and then choose a
spawn point within its borders. Your aircraft is kept inside those borders during
flight, and you only see and fight pilots in the same country. Empty lobbies stay
available for new pilots.

To enable multiplayer networking, deploy the WebSocket relay in `server/` to
Render using the steps in `server/README.md`, then set `MULTIPLAYER_URL` near
the top of `game.js` to your service's `wss://` URL and publish the updated game.

Leave `MULTIPLAYER_URL` as `""` to run single-player with no network.

Before you spawn in Multiplayer, red dots on the globe show other pilots in
your selected country. In flight, other aircraft render as the same exterior
model with a callsign label, and the 3D Cesium globe in the top-left corner
shows your position, heading, and nearby pilots. Single Player has no combat
or multiplayer state.

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
| Left click or hold (Multiplayer) | Fire guns along the fixed cockpit-glass sight |
| Keep an enemy in the sight for 3 seconds, then `F` | Lock and launch a missile |
| `C` (Multiplayer) | Deploy a flare to decoy incoming missiles |
| `[` / `]` | Nudge the model's nose alignment (debug) |
| Move mouse | Look around from the cockpit; cursor locks in flight |
| `Esc` | Unlock the cursor and open or close settings; flight keeps running |
| Full screen button | Enter or exit fullscreen |

The aircraft retains its pitch and bank after you release the controls. Hold `X` to smoothly return to level flight, or use the opposite key for manual corrections. Press `Q` for a controlled 180° reversal; hold `W` or `S` through a full pitch rotation to loop. Fly from the separate 3D cockpit and move the mouse to look around; the cursor locks to the game during flight. Press `Esc` to unlock it and open settings, then close settings to relock. Press `V` to switch to a chase view, where you can inspect the exterior aircraft. Remote pilots always see the exterior model. Use in-flight Settings to change steering and camera sensitivity or field of view. The settings overlay does not pause the online simulation. Leaving or being shot down returns to the globe-based mode menu. Settings are saved in this browser.

Gun rounds are small, untextured bright points with short glowing trails, inherit the aircraft's velocity, and drop under gravity. A quick click fires at least one round; holding the button fires a stream. The glass sight is fixed to the aircraft's forward direction and there is no screen crosshair or gun-heat bar. Rounds despawn after traveling 12 km. Multiplayer pilots also see the same visible bullets, missiles, and red-smoke flares.

Keep an enemy within the missile tracking area in front of the aircraft for 3 seconds to lock on; press `F` to launch. Missiles home toward their locked target and appear to other pilots. Press `C` to drop a flare; a nearby flare can pull an incoming missile off course. All players in a country lobby are opponents in free-for-all combat and use the same aircraft model. The flight radar is a 3D Cesium globe centered on your position, with your heading shown as a blue arrow and enemy pilots as red arrows.

The speed readout is Mach; hold `Shift` to accelerate toward Mach 10, with throttle reaching full in about one second. Missile tracking accepts a target in a wider 24-degree cone and beeps after a 3-second continuous track. The minimap uses a blue heading arrow for you and red heading arrows for enemies.

In Multiplayer, your aircraft has 100 hull. Gun hits deal 12 damage and missile hits deal 40; the HULL display shows your remaining health. At 40 hull or lower, smoke trails from your aircraft. A lethal hit or ground impact explodes your plane, shows a brief destruction screen, then returns you to the globe-based flight-mode menu.

Country boundaries are simplified Natural Earth 1:110m admin-0 boundaries
provided in `assets/countries.geojson` (public domain). Source and details:
[Natural Earth Data](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/).

## Credits

F-15C Eagle (USA) model by 42manako, licensed CC-BY-NC 4.0 via [Sketchfab](https://sketchfab.com/3d-models/f-15c-eagle-usa-2ba8289816584e97875c3a8e058108b5). Non-commercial use only.
