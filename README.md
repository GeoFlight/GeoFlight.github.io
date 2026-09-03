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
| `W` / `S` | Pitch up / down |
| `A` / `D` or Left / Right arrows | Bank and turn left / right |
| `Z` / `X` | Barrel roll left / right |
| `Shift`, Space, Up arrow, or `I` | Increase throttle |
| `Ctrl`, Down arrow, or `K` | Reduce throttle and brake (can stop on the ground) |
| `R` | Reset to the selected spawn point |

The camera follows behind and slightly above the aircraft. It uses the jet's actual direction of travel, so it remains aligned as the plane banks and turns.

## Credits

Jet model by jeremy, licensed CC-BY via [Poly Pizza](https://poly.pizza/m/6fyLMORhgGK).
