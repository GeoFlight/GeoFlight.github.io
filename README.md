# GeoFlight

GeoFlight is a browser-based, 1:1 Earth flight simulator built with Cesium. Choose any point on the globe, spawn a jet above the terrain, and fly with a third-person chase camera.

## Run it

Serve this folder with any static web server, then open `index.html` through that server. For example, with Node.js installed:

```powershell
npx serve .
```

The Cesium token in `game.js` must permit the URL where the game is hosted. Replace it with your own restricted Cesium ion token before deploying publicly.

## Controls

| Control | Action |
| --- | --- |
| `W` / `S` | Pitch up / down; hold for a full loop |
| `A` / `D` or Left / Right arrows | Bank and turn; hold for a full roll |
| `Shift`, Space, Up arrow, or `I` | Increase throttle |
| `Ctrl`, Down arrow, or `K` | Reduce throttle and brake; use briefly in a bank for a tighter airbrake turn |
| `R` | Reset to the selected spawn point |

The aircraft retains its pitch and bank after you release the controls. Use the opposite key to roll or pitch back to the attitude you want. The camera follows behind and slightly above the aircraft.

## Credits

Jet model by jeremy, licensed CC-BY via [Poly Pizza](https://poly.pizza/m/6fyLMORhgGK).
