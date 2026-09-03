/* ==========================================================================
   GEOFLIGHT — game.js
   ==========================================================================
   Architecture (kept deliberately separated so multiplayer can be bolted on
   later without a rewrite):

     CesiumWorld        — owns the Viewer, terrain, base camera
     SpawnSelector       — start-screen click-to-pick UX, spawn marker
     PlayerState         — the plain-data state of THIS player's aircraft
                            (lat/lon/height/heading/pitch/roll/speed).
                            This is exactly the shape that will later be
                            serialized and sent over the WebSocket to a
                            Render-hosted multiplayer server, and is the
                            shape remote players' state will arrive in.
     Aircraft             — owns the Cesium Entity/model and renders a
                            PlayerState to the globe every frame.
     FlightController     — reads keyboard input and integrates it into a
                            PlayerState (basic flight-feel physics; the only
                            piece that should need replacing when "proper"
                            flight physics arrive later).
     ChaseCamera          — points the Cesium camera at an Aircraft.
     HUD                  — renders a PlayerState into the on-screen HUD DOM.

   None of these classes know about each other's internals — they only pass
   PlayerState objects and a Cesium Viewer reference around. That's the seam
   multiplayer sync will plug into later (remote players = more Aircraft
   instances driven by network-received PlayerState instead of
   FlightController).
   ========================================================================== */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

// Cesium ion browser token — public, "assets:read" only, restricted via
// Cesium ion's "Allowed URLs" to the GeoFlight GitHub Pages origin.
// Replace with your own token before deploying.
const CESIUM_ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IlhacXpNblJUY1J2eTg3U0QiLCJqdGkiOiJjNWIyNzAzZS1iY2IyLTRkZGEtYWQ2YS0yZDM1NWNmMDZmNjAiLCJpZCI6NDc3NDU1LCJzdWIiOiJwb2x5ZmxpZ2h0IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6InBvbHlmbGlnaHQgd2ViIiwiaWF0IjoxNzg4MzgzNjIzfQ.hoBg5fsKviVL3a4u55JKuie57flzrKkSdUkRqjEOHTk";

const AIRCRAFT_MODEL_URL = "assets/planes/jet.glb";
const SPAWN_HEIGHT_ABOVE_TERRAIN = 15; // meters — avoids spawning inside the ground
// The source model is authored in meters. Keeping it close to 1:1 avoids the
// aircraft reading like a giant object next to the terrain and globe.
const AIRCRAFT_MODEL_SCALE = 0.55;
const MIN_TERRAIN_CLEARANCE = 3;       // meters — how close to the ground before we clamp

// Cesium automatically converts glTF 2.0's Y-up/Z-forward convention to its
// X-forward/Z-up entity frame. Do not apply another import-axis correction.

// ---------------------------------------------------------------------------
// CesiumWorld — the globe itself
// ---------------------------------------------------------------------------

class CesiumWorld {
  constructor(containerId) {
    Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

    this.viewer = new Cesium.Viewer(containerId, {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
    });

    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.globe.depthTestAgainstTerrain = true;
    this.viewer.scene.skyAtmosphere.show = true;
    // Favor steady gameplay frame rates over rendering more physical pixels
    // than the display needs. Terrain tiles can also remain a little coarser
    // while flying quickly, which reduces GPU and network pressure.
    this.viewer.resolutionScale = 1.0;
    this.viewer.scene.globe.maximumScreenSpaceError = 3.5;
    this.viewer.scene.fog.enabled = true;

    // Start-screen framing: full Earth from space.
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(0, 20, 22000000),
      duration: 0,
    });
  }

  /** Sample the terrain height at a lon/lat, in degrees. Returns meters (0 if unavailable). */
  async sampleTerrainHeight(longitudeDeg, latitudeDeg) {
    const carto = Cesium.Cartographic.fromDegrees(longitudeDeg, latitudeDeg);
    try {
      const [sampled] = await Cesium.sampleTerrainMostDetailed(
        this.viewer.terrainProvider,
        [carto]
      );
      return sampled.height ?? 0;
    } catch (e) {
      console.warn("Terrain sampling failed, defaulting to 0m", e);
      return 0;
    }
  }

  /**
   * Synchronous terrain height lookup using whatever terrain tiles are
   * currently loaded at this lon/lat, in degrees. Cheap enough to call every
   * frame (unlike sampleTerrainHeight), which is what makes real-time
   * ground-collision clamping possible. Returns undefined if no terrain tile
   * is loaded yet at that location (falls back to ellipsoid height 0 by the
   * caller in that case).
   */
  getHeightSync(longitudeDeg, latitudeDeg) {
    const carto = Cesium.Cartographic.fromDegrees(longitudeDeg, latitudeDeg);
    return this.viewer.scene.globe.getHeight(carto);
  }
}

// ---------------------------------------------------------------------------
// SpawnSelector — start-screen "click the globe to pick a spawn" flow
// ---------------------------------------------------------------------------

class SpawnSelector {
  constructor(world, ui) {
    this.world = world;
    this.ui = ui;
    this.selectedLonLat = null; // { longitude, latitude } in degrees
    this.markerEntity = null;

    this.handler = new Cesium.ScreenSpaceEventHandler(this.world.viewer.scene.canvas);
    this.handler.setInputAction(
      (click) => this._onClick(click),
      Cesium.ScreenSpaceEventType.LEFT_CLICK
    );
  }

  _onClick(click) {
    const scene = this.world.viewer.scene;
    const cartesian = scene.pickPosition
      ? scene.pickPosition(click.position)
      : this.world.viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);

    // Fall back to ellipsoid pick if the depth buffer pick misses (e.g. no
    // terrain loaded yet at that spot).
    const finalCartesian =
      cartesian ?? this.world.viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);

    if (!Cesium.defined(finalCartesian)) return;

    const carto = Cesium.Cartographic.fromCartesian(finalCartesian);
    const longitude = Cesium.Math.toDegrees(carto.longitude);
    const latitude = Cesium.Math.toDegrees(carto.latitude);

    this._setSelection(longitude, latitude);
  }

  _setSelection(longitude, latitude) {
    this.selectedLonLat = { longitude, latitude };

    if (!this.markerEntity) {
      this.markerEntity = this.world.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
        point: {
          pixelSize: 14,
          color: Cesium.Color.fromCssColorString("#5eeecb").withAlpha(0.9),
          outlineColor: Cesium.Color.fromCssColorString("#060a12"),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        billboard: undefined,
      });
    } else {
      this.markerEntity.position = Cesium.Cartesian3.fromDegrees(longitude, latitude);
    }

    this.ui.onSpawnSelected(longitude, latitude);
  }

  clearMarker() {
    if (this.markerEntity) {
      this.world.viewer.entities.remove(this.markerEntity);
      this.markerEntity = null;
    }
  }

  destroy() {
    this.handler.destroy();
  }
}

// ---------------------------------------------------------------------------
// PlayerState — plain-data shape shared by local + (eventually) remote players
// ---------------------------------------------------------------------------

class PlayerState {
  constructor({ longitude, latitude, height, heading = 0, pitch = 0, roll = 0, speed = 60, throttle = 0.018, pitchRate = 0, rollRate = 0 }) {
    this.longitude = longitude; // degrees
    this.latitude = latitude;   // degrees
    this.height = height;       // meters above ellipsoid
    this.heading = heading;     // radians
    this.pitch = pitch;         // radians
    this.roll = roll;           // radians
    this.speed = speed;         // meters/second (true airspeed)
    this.throttle = throttle;   // 0–1 engine setting
    this.verticalSpeed = 0;     // meters/second, positive = climbing
    this.pitchRate = pitchRate; // radians/second
    this.rollRate = rollRate;   // radians/second
  }

  clone() {
    return new PlayerState(this);
  }
}

// ---------------------------------------------------------------------------
// Aircraft — the visual representation of a PlayerState in the Cesium scene
// ---------------------------------------------------------------------------

class Aircraft {
  constructor(world, modelUrl) {
    this.world = world;

    this.entity = world.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      model: {
        uri: modelUrl,
        scale: AIRCRAFT_MODEL_SCALE,
        minimumPixelSize: 0,
        runAnimations: false,
      },
      orientation: Cesium.Quaternion.IDENTITY,
    });
  }

  /** Push a PlayerState onto the Cesium entity for this frame. */
  render(state) {
    const position = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    // Cesium's heading-zero entity axis faces local east, whereas flight
    // heading zero in this game is north. Correct that heading offset here
    // (not as a model-local rotation) so the camera follows behind the nose
    // and W/S/A/D keep their normal pitch/bank axes.
    const hpr = new Cesium.HeadingPitchRoll(
      state.heading - Cesium.Math.PI_OVER_TWO,
      state.pitch,
      state.roll
    );
    const worldOrientation = Cesium.Transforms.headingPitchRollQuaternion(
      position,
      hpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      new Cesium.Quaternion()
    );

    this.entity.position = position;
    this.entity.orientation = worldOrientation;
  }
}

// ---------------------------------------------------------------------------
// FlightController — keyboard input -> PlayerState integration
// ---------------------------------------------------------------------------
// This is intentionally the only place with "physics." Keep it self
// contained so it's easy to swap for a real flight model later.

class FlightController {
  constructor(initialState) {
    this.state = initialState.clone();
    this.spawnState = initialState.clone();

    this.keys = new Set();
    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));
    // A keyup is not delivered when the browser loses focus. Clearing the
    // held-key state prevents the aircraft from continuing to turn or thrust
    // after the player returns to the tab.
    window.addEventListener("blur", () => this.keys.clear());

    // Keyboard flight model: inputs apply rotational force, then damping and
    // light stability bring the aircraft back toward trimmed, level flight.
    // This avoids instant attitude snaps while remaining controllable.
    this.maxPitch = Cesium.Math.toRadians(22);
    this.maxBank = Cesium.Math.toRadians(42);
    this.maxPitchRate = Cesium.Math.toRadians(36);
    this.maxRollRate = Cesium.Math.toRadians(72);
    this.pitchAcceleration = Cesium.Math.toRadians(140);
    this.rollAcceleration = Cesium.Math.toRadians(280);
    this.angularDamping = 4.2;
    this.levelingStrength = 2.4;
    this.bankTurnStrength = 13.2; // tighter, fighter-style coordinated turns
    this.minSpeed = 0;          // braking can bring a landed aircraft to rest
    this.maxSpeed = 3430;       // approximately Mach 10 at sea level
    this.throttleRate = 0.12;
    this.maxThrustAcceleration = 65;
    this.dragCoefficient = this.maxThrustAcceleration / this.maxSpeed;
    this.brakeDecel = 55;
    this.climbResponse = 2.8;

    // Keys that double as page-scroll/nav shortcuts in the browser — stop
    // them from scrolling the page while the aircraft is being flown.
    this.preventDefaultKeys = new Set([
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
    ]);
  }

  _onKey(e, isDown) {
    if (this.preventDefaultKeys.has(e.code)) e.preventDefault();
    this.keys[isDown ? "add" : "delete"](e.code);
  }

  reset() {
    this.state = this.spawnState.clone();
    this.keys.delete("KeyR");
    this.justReset = true;
  }

  /** Advance the flight state by dt seconds based on currently-held keys. */
  update(dt) {
    this.justReset = false;
    const k = this.keys;
    const s = this.state;

    // --- Assisted attitude controls ---
    let pitchInput = 0;
    if (k.has("KeyW")) pitchInput += 1; // nose up
    if (k.has("KeyS")) pitchInput -= 1; // nose down

    // A/D and the left/right arrows are deliberately identical: each banks
    // the plane into a visible, coordinated turn in that direction.
    let rollInput = 0;
    if (k.has("KeyA") || k.has("ArrowLeft") || k.has("KeyJ")) rollInput -= 1;
    if (k.has("KeyD") || k.has("ArrowRight") || k.has("KeyL")) rollInput += 1;

    // Integrate angular velocity instead of snapping directly to an angle.
    // The self-leveling term is deliberately weak: it feels like a stable jet,
    // not a camera that forcibly pops upright when a key is released.
    s.pitchRate += (pitchInput * this.pitchAcceleration - s.pitch * this.levelingStrength) * dt;
    s.rollRate += (rollInput * this.rollAcceleration - s.roll * this.levelingStrength) * dt;
    const angularDecay = Math.exp(-this.angularDamping * dt);
    s.pitchRate *= angularDecay;
    s.rollRate *= angularDecay;
    s.pitchRate = Cesium.Math.clamp(s.pitchRate, -this.maxPitchRate, this.maxPitchRate);
    s.rollRate = Cesium.Math.clamp(s.rollRate, -this.maxRollRate, this.maxRollRate);
    s.pitch += s.pitchRate * dt;
    s.roll += s.rollRate * dt;
    // Keyboard banking is momentary: once A/D is released, quickly return
    // the visual model to level flight instead of leaving it side-on.
    if (rollInput === 0) {
      const levelBlend = 1 - Math.exp(-7.5 * dt);
      s.roll += (0 - s.roll) * levelBlend;
      s.rollRate *= 1 - levelBlend;
    }
    if (Math.abs(s.pitch) >= this.maxPitch) s.pitchRate = 0;
    if (Math.abs(s.roll) >= this.maxBank) s.rollRate = 0;
    s.pitch = Cesium.Math.clamp(s.pitch, -this.maxPitch, this.maxPitch);
    s.roll = Cesium.Math.clamp(s.roll, -this.maxBank, this.maxBank);

    // A banked turn follows the coordinated-turn relationship:
    // turn rate = g × tan(bank) / airspeed.
    if (Math.abs(s.roll) > Cesium.Math.toRadians(0.5)) {
      const turnRate = (this.bankTurnStrength * Math.tan(s.roll)) / Math.max(s.speed, 5);
      s.heading += turnRate * dt;
    }

    // Keep the heading bounded. This avoids losing precision during long
    // flights while preserving Cesium's clockwise-from-north convention.
    s.heading = Cesium.Math.negativePiToPi(s.heading);

    // --- Throttle / speed ---
    // Shift/Space increase engine power. Ctrl or Down lowers power and adds
    // wheel-brake force, allowing a landed aircraft to stop completely.
    if (
      k.has("ShiftLeft") || k.has("ShiftRight") || k.has("Space") ||
      k.has("ArrowUp") || k.has("KeyI")
    ) {
      s.throttle += this.throttleRate * dt;
    }
    const braking = k.has("ControlLeft") || k.has("ControlRight") ||
      k.has("ArrowDown") || k.has("KeyK");
    if (braking) s.throttle -= this.throttleRate * dt * 1.8;
    s.throttle = Cesium.Math.clamp(s.throttle, 0, 1);
    // Thrust and drag, rather than a forced target speed. Full power reaches
    // the Mach 10 cap naturally; a low initial throttle holds takeoff speed.
    s.speed += (s.throttle * this.maxThrustAcceleration - s.speed * this.dragCoefficient) * dt;
    if (braking) s.speed -= this.brakeDecel * dt;
    s.speed = Cesium.Math.clamp(s.speed, this.minSpeed, this.maxSpeed);

    // --- Reset ---
    if (k.has("KeyR")) {
      this.reset();
      return this.state;
    }

    // --- Flight path ---
    // Velocity follows pitch with a little inertia. This is deliberately
    // assisted rather than a full aerodynamic simulation: it is smooth and
    // predictable with a keyboard while bank still produces real turns.
    const desiredVerticalSpeed = s.speed * Math.sin(s.pitch);
    const climbResponse = 1 - Math.exp(-this.climbResponse * dt);
    s.verticalSpeed += (desiredVerticalSpeed - s.verticalSpeed) * climbResponse;
    const climbRate = s.verticalSpeed * dt;
    const groundDistance = s.speed * Math.cos(s.pitch) * dt;

    const currentCartesian = Cesium.Cartesian3.fromDegrees(s.longitude, s.latitude, s.height);
    const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(currentCartesian);

    const forwardLocal = new Cesium.Cartesian3(
      Math.sin(s.heading) * groundDistance,
      Math.cos(s.heading) * groundDistance,
      climbRate
    );

    const forwardWorld = Cesium.Matrix4.multiplyByPointAsVector(
      enuTransform,
      forwardLocal,
      new Cesium.Cartesian3()
    );

    const newCartesian = Cesium.Cartesian3.add(currentCartesian, forwardWorld, new Cesium.Cartesian3());
    const newCarto = Cesium.Cartographic.fromCartesian(newCartesian);

    s.longitude = Cesium.Math.toDegrees(newCarto.longitude);
    s.latitude = Cesium.Math.toDegrees(newCarto.latitude);
    s.height = newCarto.height;

    return s;
  }

  /**
   * Clamp state.height so the aircraft can't pass through the ground.
   * Called from the main loop (rather than inline in update()) because it
   * needs a synchronous terrain-height lookup from the CesiumWorld, which
   * FlightController intentionally has no reference to — this keeps ground
   * collision a "world" concern rather than baking Cesium globe access into
   * the flight-feel code above.
   */
  clampToTerrain(groundHeight) {
    if (groundHeight === undefined) return; // terrain tile not loaded yet at this spot
    const s = this.state;
    const minHeight = groundHeight + MIN_TERRAIN_CLEARANCE;
    if (s.height < minHeight) {
      s.height = minHeight;
      if (s.verticalSpeed < 0) s.verticalSpeed = 0;
      if (s.pitch < 0) s.pitch = 0; // stop nosing further into the ground
      s.speed = Math.max(this.minSpeed, s.speed * 0.985); // slight speed scrub on contact
    }
  }
}

// ---------------------------------------------------------------------------
// ChaseCamera — third-person camera locked behind/above an Aircraft
// ---------------------------------------------------------------------------

class ChaseCamera {
  constructor(world) {
    this.world = world;
    this.behindDistance = 72; // meters behind the aircraft
    this.aboveDistance = 42;  // meters above it: a clearer elevated chase view
    this.travelDirection = null; // world-space unit vector aligned with flight heading
    // A wider lens gives context for the full-scale globe and prevents the
    // aircraft from filling the frame during low passes.
    this.world.viewer.camera.frustum.fov = Cesium.Math.toRadians(82);
  }

  reset() {
    this.travelDirection = null;
  }

  // Deliberately built from the aircraft's actual frame-to-frame motion
  // (rather than from state.heading directly) so the camera always sits
  // behind the direction the plane is really moving.
  follow(state) {
    const position = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const ellipsoid = this.world.viewer.scene.globe.ellipsoid;
    const up = ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3());

    // Use the same heading that drives the flight physics. Deriving camera
    // direction from one frame's movement can flip during terrain contact,
    // reset, or a steep climb and causes the intermittent side-on view.
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    this.travelDirection = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(Math.sin(state.heading), Math.cos(state.heading), 0),
      this.travelDirection ?? new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.normalize(this.travelDirection, this.travelDirection);

    const behindOffset = Cesium.Cartesian3.multiplyByScalar(
      this.travelDirection, -this.behindDistance, new Cesium.Cartesian3()
    );
    const aboveOffset = Cesium.Cartesian3.multiplyByScalar(up, this.aboveDistance, new Cesium.Cartesian3());

    const cameraPosition = Cesium.Cartesian3.add(position, behindOffset, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(cameraPosition, aboveOffset, cameraPosition);

    const lookTarget = Cesium.Cartesian3.add(
      position,
      Cesium.Cartesian3.multiplyByScalar(this.travelDirection, 16, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const direction = Cesium.Cartesian3.subtract(lookTarget, cameraPosition, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(direction, direction);

    this.world.viewer.camera.setView({
      destination: cameraPosition,
      orientation: { direction, up },
    });
  }
}

// ---------------------------------------------------------------------------
// HUD — DOM readout of a PlayerState
// ---------------------------------------------------------------------------

class HUD {
  constructor() {
    this.el = document.getElementById("flightHud");
    this.altEl = document.getElementById("hudAlt");
    this.speedEl = document.getElementById("hudSpeed");
    this.latEl = document.getElementById("hudLat");
    this.lonEl = document.getElementById("hudLon");
  }

  show() {
    this.el.classList.remove("hidden");
  }

  update(state) {
    this.altEl.textContent = `${Math.round(state.height)} m`;
    this.speedEl.textContent = `${Math.round(state.speed)} m/s`;
    this.latEl.textContent = `${state.latitude.toFixed(4)}°`;
    this.lonEl.textContent = `${state.longitude.toFixed(4)}°`;
  }
}

// ---------------------------------------------------------------------------
// StartScreenUI — wires the start-screen DOM to the SpawnSelector
// ---------------------------------------------------------------------------

class StartScreenUI {
  constructor(onStartFlight) {
    this.onStartFlight = onStartFlight;
    this.screenEl = document.getElementById("startScreen");
    this.selectionBox = document.getElementById("selectionBox");
    this.selectionCoords = document.getElementById("selectionCoords");
    this.startBtn = document.getElementById("startFlightBtn");
    this.creditsToggle = document.getElementById("creditsToggle");
    this.creditsPanel = document.getElementById("creditsPanel");

    this.startBtn.addEventListener("click", () => {
      if (this.startBtn.disabled) return;
      this.onStartFlight();
    });

    this.creditsToggle.addEventListener("click", () => {
      this.creditsPanel.classList.toggle("hidden");
    });
  }

  onSpawnSelected(longitude, latitude) {
    this.selectionBox.classList.remove("selection-box--empty");
    this.selectionBox.classList.add("selection-box--filled");
    this.selectionCoords.textContent = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    this.startBtn.disabled = false;
  }

  hide() {
    this.screenEl.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Main — wires everything together
// ---------------------------------------------------------------------------

async function main() {
  const world = new CesiumWorld("cesiumContainer");
  const hud = new HUD();
  const chaseCamera = new ChaseCamera(world);

  let flightController = null;
  let aircraft = null;
  let flying = false;

  const startScreenUI = new StartScreenUI(async () => {
    const { longitude, latitude } = spawnSelector.selectedLonLat;
    await beginFlight(longitude, latitude);
  });

  const spawnSelector = new SpawnSelector(world, startScreenUI);

  async function beginFlight(longitude, latitude) {
    startScreenUI.hide();
    spawnSelector.clearMarker();

    const terrainHeight = await world.sampleTerrainHeight(longitude, latitude);
    const spawnState = new PlayerState({
      longitude,
      latitude,
      height: terrainHeight + SPAWN_HEIGHT_ABOVE_TERRAIN,
      heading: 0,
      pitch: 0,
      roll: 0,
      speed: 60,
    });

    aircraft = new Aircraft(world, AIRCRAFT_MODEL_URL);
    flightController = new FlightController(spawnState);
    chaseCamera.reset();
    hud.show();
    flying = true;
  }

  // Drive flight kinematics off real wall-clock time rather than Cesium's
  // simulation clock (which can run at non-1x multipliers), and cap dt so a
  // dropped/backgrounded frame can't cause a huge single-step jump.
  let lastFrameTime = performance.now();

  world.viewer.scene.postRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(1 / 20, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (!flying || !flightController || !aircraft) return;

    flightController.update(dt);

    if (flightController.justReset) chaseCamera.reset();

    // Ground-collision clamp: keep the aircraft from passing through
    // terrain. Done here (not inside FlightController.update) since it
    // needs a globe height lookup — see clampToTerrain()'s doc comment.
    const groundHeight = world.getHeightSync(
      flightController.state.longitude,
      flightController.state.latitude
    );
    flightController.clampToTerrain(groundHeight);

    const state = flightController.state;

    aircraft.render(state);
    chaseCamera.follow(state);
    hud.update(state);
  });
}

main();
