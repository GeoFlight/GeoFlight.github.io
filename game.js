/* ==========================================================================
   POLYFLIGHT — game.js
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
// Cesium ion's "Allowed URLs" to the PolyFlight GitHub Pages origin.
// Replace with your own token before deploying.
const CESIUM_ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IlhacXpNblJUY1J2eTg3U0QiLCJqdGkiOiJjNWIyNzAzZS1iY2IyLTRkZGEtYWQ2YS0yZDM1NWNmMDZmNjAiLCJpZCI6NDc3NDU1LCJzdWIiOiJwb2x5ZmxpZ2h0IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6InBvbHlmbGlnaHQgd2ViIiwiaWF0IjoxNzg4MzgzNjIzfQ.hoBg5fsKviVL3a4u55JKuie57flzrKkSdUkRqjEOHTk";

const AIRCRAFT_MODEL_URL = "assets/planes/jet.glb";
const SPAWN_HEIGHT_ABOVE_TERRAIN = 15; // meters — avoids spawning inside the ground
const AIRCRAFT_MODEL_SCALE = 8.0;      // tune to taste once the model is in-scene
const MIN_TERRAIN_CLEARANCE = 3;       // meters — how close to the ground before we clamp

// This particular .glb wasn't authored with Cesium's assumed model axes
// (forward = +X, up = +Z), so it needs a one-time local rotation to sit
// correctly: nose along the direction of travel, wings level. Tune these
// in 90°/180° steps if the model ever looks off — heading is "which way the
// nose points" (sideways = wrong heading), pitch is "nose up/down", roll is
// "banked/on its side".
const AIRCRAFT_MODEL_HEADING_CORRECTION_DEG = 270;
const AIRCRAFT_MODEL_PITCH_CORRECTION_DEG = 0;
const AIRCRAFT_MODEL_ROLL_CORRECTION_DEG = 0;

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
  constructor({ longitude, latitude, height, heading = 0, pitch = 0, roll = 0, speed = 60 }) {
    this.longitude = longitude; // degrees
    this.latitude = latitude;   // degrees
    this.height = height;       // meters above ellipsoid
    this.heading = heading;     // radians
    this.pitch = pitch;         // radians
    this.roll = roll;           // radians
    this.speed = speed;         // meters/second (true airspeed)
    this.verticalSpeed = 0;     // meters/second, positive = climbing
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
    this.modelCorrection = Cesium.Quaternion.fromHeadingPitchRoll(
      new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(AIRCRAFT_MODEL_HEADING_CORRECTION_DEG),
        Cesium.Math.toRadians(AIRCRAFT_MODEL_PITCH_CORRECTION_DEG),
        Cesium.Math.toRadians(AIRCRAFT_MODEL_ROLL_CORRECTION_DEG)
      )
    );

    this.entity = world.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      model: {
        uri: modelUrl,
        scale: AIRCRAFT_MODEL_SCALE,
        minimumPixelSize: 48,
        runAnimations: false,
      },
      orientation: Cesium.Quaternion.IDENTITY,
    });
  }

  /** Push a PlayerState onto the Cesium entity for this frame. */
  render(state) {
    const position = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    // Use Cesium's native HPR axes: heading = yaw, pitch = nose up/down,
    // roll = rotation around the aircraft's forward axis. The previous
    // implementation applied roll around UNIT_Z, the vertical axis, which
    // made pitch/roll interact incorrectly and could put the model on its side.
    const hpr = new Cesium.HeadingPitchRoll(state.heading, state.pitch, state.roll);
    const worldOrientation = Cesium.Transforms.headingPitchRollQuaternion(
      position,
      hpr,
      new Cesium.Quaternion()
    );

    // Apply only the model's fixed import correction after the flight attitude.
    const orientation = Cesium.Quaternion.multiply(
      worldOrientation,
      this.modelCorrection,
      new Cesium.Quaternion()
    );

    this.entity.position = position;
    this.entity.orientation = orientation;
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

    // Tunables — arbitrary but chosen to feel like a plane, not an ice cube.
    this.pitchRate = 1.1;      // rad/s at full input
    this.rollRate = 2.0;       // rad/s at full input
    this.yawRate = 0.12;       // gentle rudder/yaw authority; turns come from banking
    this.bankTurnStrength = 9.81; // m/s^2 equivalent lift/gravity used for coordinated turns
    this.minSpeed = 0;         // m/s — allows a landed aircraft to come to a complete stop
    this.maxSpeed = 3430;       // m/s — approximately Mach 10 at sea level
    this.throttleAccel = 65;   // m/s^2 while throttle held
    this.throttleDecel = 80;   // m/s^2 while brake held
    this.dragDecel = 3;        // m/s^2 passive drag toward a stop
    this.rollAutoLevel = 0.15; // gentle self-leveling so roll doesn't run away

    // Simple aerodynamic model: lift falls rapidly with airspeed, so an
    // aircraft with no airspeed can no longer magically hover in place.
    this.gravity = 9.81;
    this.referenceSpeed = 60;      // m/s: roughly the speed for 1g level flight
    this.liftBase = 1.0;
    this.liftAoA = 4.0;             // lift increase per radian of angle of attack
    this.maxLift = 2.5;             // avoid absurd arcade-style acceleration
    this.verticalDrag = 0.35;

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
  }

  /** Advance the flight state by dt seconds based on currently-held keys. */
  update(dt) {
    const k = this.keys;
    const s = this.state;

    // --- Rotational input ---
    let pitchInput = 0;
    if (k.has("KeyW")) pitchInput += 1; // nose up
    if (k.has("KeyS")) pitchInput -= 1; // nose down

    let rollInput = 0;
    if (k.has("KeyA")) rollInput -= 1; // roll left
    if (k.has("KeyD")) rollInput += 1; // roll right

    // Yaw doubles up on three schemes: Q/E, arrow left/right, and I/J/K/L
    // (for keyboards/layouts without dedicated arrow keys).
    let yawInput = 0;
    if (k.has("KeyQ") || k.has("ArrowLeft") || k.has("KeyJ")) yawInput -= 1; // yaw left
    if (k.has("KeyE") || k.has("ArrowRight") || k.has("KeyL")) yawInput += 1; // yaw right

    // Pitch only changes the aircraft's nose angle.  It does NOT change heading,
    // so W/S cannot accidentally make the aircraft yaw sideways.
    s.pitch += pitchInput * this.pitchRate * dt;

    // A/D is a true bank input.  The aircraft turns because its lift vector
    // is tilted by the bank angle, rather than because we directly rotate the
    // nose left/right like a car.
    s.roll += rollInput * this.rollRate * dt;
    const maxBank = Cesium.Math.toRadians(85);
    s.roll = Cesium.Math.clamp(s.roll, -maxBank, maxBank);

    // Small rudder authority remains on Q/E, but normal turning is produced by
    // the bank angle above.  This also keeps the aircraft controllable at low
    // bank angles without allowing instant sideways steering.
    s.heading += yawInput * this.yawRate * dt;

    // Coordinated banked turn: heading rate ~= g*tan(bank)/airspeed.
    // Use the current speed so high-speed aircraft make wider, more realistic
    // turns.  A tiny floor prevents division by zero while stationary.
    if (Math.abs(s.roll) > Cesium.Math.toRadians(1) && s.speed > 1) {
      const turnRate = (this.bankTurnStrength * Math.tan(s.roll)) / Math.max(s.speed, 5);
      s.heading += turnRate * dt;
    }

    // Gentle auto-level on roll so the plane doesn't drift into a permanent
    // bank the way a keyboard-only control scheme otherwise would.
    if (rollInput === 0) {
      s.roll -= s.roll * Math.min(1, this.rollAutoLevel * dt * 4);
    }

    // Clamp pitch so the aircraft can't flip nose-through-tail instantly.
    const maxPitch = Cesium.Math.toRadians(45);
    s.pitch = Cesium.Math.clamp(s.pitch, -maxPitch, maxPitch);

    // --- Throttle / speed ---
    // Shift/Ctrl/Space are the primary scheme; ArrowUp/ArrowDown and I/K
    // mirror them for players who'd rather accelerate/brake with their
    // right hand (or don't have arrow keys at all).
    if (
      k.has("ShiftLeft") || k.has("ShiftRight") || k.has("Space") ||
      k.has("ArrowUp") || k.has("KeyI")
    ) {
      s.speed += this.throttleAccel * dt;
    }
    if (
      k.has("ControlLeft") || k.has("ControlRight") ||
      k.has("ArrowDown") || k.has("KeyK")
    ) {
      s.speed -= this.throttleDecel * dt;
    }
    // Passive drag pulls speed back toward minSpeed so it doesn't idle at max.
    if (s.speed > this.minSpeed) {
      s.speed -= this.dragDecel * dt * 0.15;
    }
    s.speed = Cesium.Math.clamp(s.speed, this.minSpeed, this.maxSpeed);

    // --- Reset ---
    if (k.has("KeyR")) {
      this.reset();
      return this.state;
    }

    // --- Basic aerodynamic lift + gravity ---
    // Pitch is the aircraft attitude; verticalSpeed is the actual flight-path
    // speed.  This distinction is what makes the aircraft fall when it has no
    // airspeed instead of simply moving wherever the nose points.
    const speedRatio = Math.min(1.5, s.speed / this.referenceSpeed);
    const flightPathAngle = Math.atan2(s.verticalSpeed, Math.max(s.speed, 0.1));
    const angleOfAttack = s.pitch - flightPathAngle;
    let lift = (speedRatio * speedRatio) *
      (this.liftBase + this.liftAoA * angleOfAttack);
    lift = Cesium.Math.clamp(lift, 0, this.maxLift);

    // Banking tilts the lift vector away from vertical.
    const verticalLift = lift * this.gravity * Math.cos(s.roll);
    const verticalAcceleration = verticalLift - this.gravity - this.verticalDrag * s.verticalSpeed;
    s.verticalSpeed += verticalAcceleration * dt;

    // At very low airspeed the nose cannot generate useful lift. The aircraft
    // therefore drops naturally under gravity until it reaches the terrain.
    const climbRate = s.verticalSpeed * dt;
    const horizontalSpeed = Math.sqrt(Math.max(0, s.speed * s.speed - s.verticalSpeed * s.verticalSpeed));
    const groundDistance = horizontalSpeed * dt;

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
    this.behindDistance = 48; // meters behind the aircraft
    this.aboveDistance = 65;  // meters above the aircraft (raised for a fuller view of the plane)
    this.previousPosition = null;
    this.travelDirection = null; // world-space unit vector, last known direction of travel
  }

  // Deliberately built from the aircraft's actual frame-to-frame motion
  // (rather than from state.heading directly) so the camera always sits
  // behind and above the direction the plane is really moving — this stays
  // correct regardless of how heading/pitch/roll map onto the model's own
  // local axes, which is what caused the earlier side-on view.
  follow(state) {
    const position = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const ellipsoid = this.world.viewer.scene.globe.ellipsoid;
    const up = ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3());

    if (this.previousPosition) {
      const delta = Cesium.Cartesian3.subtract(position, this.previousPosition, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.magnitude(delta) > 0.01) {
        this.travelDirection = Cesium.Cartesian3.normalize(delta, new Cesium.Cartesian3());
      }
    }
    this.previousPosition = Cesium.Cartesian3.clone(position);

    if (!this.travelDirection) {
      // No motion yet to derive a direction from — default to due north.
      this.travelDirection = Cesium.Cartesian3.cross(up, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(this.travelDirection, this.travelDirection);
    }

    const behindOffset = Cesium.Cartesian3.multiplyByScalar(
      this.travelDirection, -this.behindDistance, new Cesium.Cartesian3()
    );
    const aboveOffset = Cesium.Cartesian3.multiplyByScalar(up, this.aboveDistance, new Cesium.Cartesian3());

    const cameraPosition = Cesium.Cartesian3.add(position, behindOffset, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(cameraPosition, aboveOffset, cameraPosition);

    const lookTarget = Cesium.Cartesian3.add(
      position,
      Cesium.Cartesian3.multiplyByScalar(this.travelDirection, 12, new Cesium.Cartesian3()),
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
