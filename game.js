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

const AIRCRAFT_MODEL_URL = "assets/planes/f-15c_eagle_usa.glb";
const SPAWN_HEIGHT_ABOVE_TERRAIN = 15; // meters — avoids spawning inside the ground
// The model file itself has been re-baked to real-world metres (19.43 m long)
// with its nose on the +Z axis Cesium expects, so no scaling or axis fudging
// is needed here any more.
const AIRCRAFT_MODEL_SCALE = 1.0;
const MIN_TERRAIN_CLEARANCE = 3;       // meters — how close to the ground before we clamp

// --- Model nose direction -------------------------------------------------
// Should now be 0. If the nose still comes out wrong, press [ and ] in flight
// to spin the model live — the HUD shows the angle. Put that number here.
let MODEL_NOSE_YAW_DEGREES = 0;

// --- Lighting -------------------------------------------------------------
// Cesium lights models with the real sun, so a plane flying at dusk or on the
// sun's far side turns nearly black. A light that tracks the camera keeps the
// aircraft readable from every angle. Set to false to go back to sunlight.
const LIGHT_FOLLOWS_CAMERA = true;
const LIGHT_INTENSITY = 3.2;           // raise for a brighter aircraft
// Ambient fill so unlit surfaces keep some shape instead of going flat black.
const MODEL_AMBIENT = 1.4;             // image-based light multiplier
const AIRCRAFT_BRIGHTNESS_BLEND = 0.22;

// --- Multiplayer ----------------------------------------------------------
// Point this at your Render service once deployed. Must be wss:// (not ws://)
// because GitHub Pages serves over https and browsers block mixed content.
// Leave it as "" to run single-player with no network at all.
const MULTIPLAYER_URL = "wss://geoflight-server.onrender.com";
const STATE_SEND_HZ = 15;              // position updates per second
const REMOTE_SMOOTHING = 0.18;         // 0..1 — higher snaps harder to new data

// --- Combat ---------------------------------------------------------------
const MAX_HEALTH = 100;
const BULLET_DAMAGE = 12;
const BULLET_SPEED = 900;              // m/s
const BULLET_RANGE = 2500;             // meters before a round despawns
const BULLET_LIFETIME = BULLET_RANGE / BULLET_SPEED;
const FIRE_INTERVAL = 0.09;            // seconds between rounds
const TRACER_INTERVAL = 5;             // only a portion of the stream is visibly traced
const TRACER_LENGTH = 24;              // meters
const BULLET_GRAVITY = 9.81;           // m/s²
const HIT_RADIUS = 8;                  // meters — approximate aircraft hit radius
const RESPAWN_DELAY = 3.0;             // seconds dead before respawn

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

    // HDR tone mapping tends to crush a dark-painted aircraft into a
    // silhouette against bright terrain. Off gives flatter but far more
    // readable colours on the model.
    this.viewer.scene.highDynamicRange = false;

    if (LIGHT_FOLLOWS_CAMERA) {
      this.light = new Cesium.DirectionalLight({
        direction: Cesium.Cartesian3.clone(this.viewer.scene.camera.directionWC),
        intensity: LIGHT_INTENSITY,
      });
      this.viewer.scene.light = this.light;
      // Re-aim it every frame so whatever the chase camera is looking at is
      // lit from roughly over the viewer's shoulder.
      this.viewer.scene.preRender.addEventListener(() => {
        Cesium.Cartesian3.clone(this.viewer.scene.camera.directionWC, this.light.direction);
      });
    }
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
  constructor({ longitude, latitude, height, heading = 0, pitch = 0, roll = 0, speed = 60, throttle = 0.18, pitchRate = 0, rollRate = 0 }) {
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

const SETTINGS_STORAGE_KEY = "geoflight-flight-settings";

class FlightSettings {
  constructor() {
    let saved = {};
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") saved = parsed;
        else console.warn("Saved flight settings are invalid; using defaults.");
      } catch (error) {
        console.warn("Could not read saved flight settings.", error);
      }
    }

    this.steeringSensitivity = this._readValue(saved.steeringSensitivity, 0.65, 0.3, 1.5);
    this.cameraSensitivity = this._readValue(saved.cameraSensitivity, 1, 0.3, 2);
  }

  _readValue(value, fallback, min, max) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Cesium.Math.clamp(numericValue, min, max) : fallback;
  }

  save() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      steeringSensitivity: this.steeringSensitivity,
      cameraSensitivity: this.cameraSensitivity,
    }));
  }
}

// ---------------------------------------------------------------------------
// Aircraft — the visual representation of a PlayerState in the Cesium scene
// ---------------------------------------------------------------------------

class Aircraft {
  constructor(world, modelUrl) {
    this.world = world;

    // Rotation applied in the model's own frame (not the world frame), so the
    // nose lines up with Cesium's forward axis without disturbing how pitch
    // and roll are applied below. The model ships pre-aligned, so this is
    // identity unless you nudge it with [ and ].
    this.noseCorrection = new Cesium.Quaternion();
    this.setNoseYaw(MODEL_NOSE_YAW_DEGREES);

    this.entity = world.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      model: {
        uri: modelUrl,
        scale: AIRCRAFT_MODEL_SCALE,
        minimumPixelSize: 0,
        runAnimations: false,
        // Ambient fill — keeps the shaded side of the fuselage from crushing
        // to black, which is what makes an unlit model look flat and muddy.
        imageBasedLightingFactor: new Cesium.Cartesian2(MODEL_AMBIENT, MODEL_AMBIENT),
        color: Cesium.Color.WHITE,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: AIRCRAFT_BRIGHTNESS_BLEND,
        // Self-shadowing on a model this detailed mostly produces speckled
        // artifacts rather than readable shadows.
        shadows: Cesium.ShadowMode.DISABLED,
      },
      orientation: Cesium.Quaternion.IDENTITY,
    });
  }

  /** Spin the model about its own up axis. Used by the [ and ] debug keys. */
  setNoseYaw(degrees) {
    MODEL_NOSE_YAW_DEGREES = degrees;
    Cesium.Quaternion.fromAxisAngle(
      Cesium.Cartesian3.UNIT_Z,
      Cesium.Math.toRadians(degrees),
      this.noseCorrection
    );
  }

  destroy() {
    this.world.viewer.entities.remove(this.entity);
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

    // Multiplying on the right applies the nose fix in model space, after the
    // flight orientation — so pitch and roll still act on the real nose and
    // wing axes.
    Cesium.Quaternion.multiply(worldOrientation, this.noseCorrection, worldOrientation);

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
  constructor(initialState, settings) {
    this.state = initialState.clone();
    this.spawnState = initialState.clone();
    this.settings = settings;

    this.keys = new Set();
    window.addEventListener("keydown", (e) => this._onKey(e, true));
    window.addEventListener("keyup", (e) => this._onKey(e, false));
    // A keyup is not delivered when the browser loses focus. Clearing the
    // held-key state prevents the aircraft from continuing to turn or thrust
    // after the player returns to the tab.
    window.addEventListener("blur", () => this.keys.clear());

    // Keyboard flight model: controls apply rotational force and the aircraft
    // retains its chosen pitch/bank when released, like a trimmed aircraft.
    this.maxPitchRate = Cesium.Math.toRadians(90);
    this.maxRollRate = Cesium.Math.toRadians(150);
    this.pitchAcceleration = Cesium.Math.toRadians(240);
    this.rollAcceleration = Cesium.Math.toRadians(480);
    this.angularDamping = 2.4;
    this.turnBankLimit = Cesium.Math.toRadians(70);
    this.bankTurnStrength = 9.81;
    this.maxTurnLoadFactor = 4;
    this.maxTurnRate = Cesium.Math.toRadians(40);
    this.minSpeed = 0;          // braking can bring a landed aircraft to rest
    this.maxSpeed = 900;        // high-speed jet range, rather than a supersonic game cap
    this.throttleRate = 0.08;
    this.maxThrustAcceleration = 24;
    this.dragCoefficient = this.maxThrustAcceleration / this.maxSpeed;
    this.brakeDecel = 22;
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

    const braking = k.has("ControlLeft") || k.has("ControlRight") ||
      k.has("ArrowDown") || k.has("KeyK");

    // Integrate angular velocity instead of snapping directly to an angle.
    // The self-leveling term is deliberately weak: it feels like a stable jet,
    // not a camera that forcibly pops upright when a key is released.
    const steeringSensitivity = this.settings.steeringSensitivity;
    s.pitchRate += pitchInput * this.pitchAcceleration * steeringSensitivity * dt;
    s.rollRate += rollInput * this.rollAcceleration * steeringSensitivity * dt;
    const angularDecay = Math.exp(-this.angularDamping * dt);
    s.pitchRate *= angularDecay;
    s.rollRate *= angularDecay;
    s.pitchRate = Cesium.Math.clamp(
      s.pitchRate,
      -this.maxPitchRate * steeringSensitivity,
      this.maxPitchRate * steeringSensitivity
    );
    s.rollRate = Cesium.Math.clamp(
      s.rollRate,
      -this.maxRollRate * steeringSensitivity,
      this.maxRollRate * steeringSensitivity
    );
    s.pitch += s.pitchRate * dt;
    s.roll += s.rollRate * dt;
    // Full loops and rolls are allowed while the key is held. Wrapping keeps
    // the state numerically stable without imposing an attitude limit.
    s.pitch = Cesium.Math.negativePiToPi(s.pitch);
    s.roll = Cesium.Math.negativePiToPi(s.roll);

    // A banked turn follows the coordinated-turn relationship:
    // turn rate = g × tan(bank) / airspeed.
    const turnBank = Cesium.Math.clamp(
      Math.asin(Math.sin(s.roll)),
      -this.turnBankLimit,
      this.turnBankLimit
    );
    if (Math.abs(turnBank) > Cesium.Math.toRadians(0.5)) {
      // Cap the coordinated turn at a high but bounded load factor. The
      // airbrake allows a tighter transient turn without an unlimited rate.
      const airbrakeTurnBoost = braking ? 1.2 : 1;
      const turnAcceleration = Math.min(
        Math.abs(this.bankTurnStrength * Math.tan(turnBank)) * airbrakeTurnBoost,
        this.maxTurnLoadFactor * 9.81
      );
      const turnRate = Cesium.Math.clamp(
        Math.sign(turnBank) * turnAcceleration / Math.max(s.speed, 5),
        -this.maxTurnRate * steeringSensitivity,
        this.maxTurnRate * steeringSensitivity
      );
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
  constructor(world, settings) {
    this.world = world;
    this.settings = settings;
    this.behindDistance = 72;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.cameraElevation = Cesium.Math.toRadians(18);
    this.minDistance = 25;
    this.maxDistance = 180;
    this.isDragging = false;
    this.enabled = false;
    this.cameraPosition = null;
    this.travelDirection = null; // world-space unit vector aligned with the aircraft nose
    this.world.viewer.camera.frustum.fov = Cesium.Math.toRadians(70);

    window.addEventListener("mousedown", (event) => {
      if (this.enabled && event.button === 2) {
        this.isDragging = true;
        event.preventDefault();
      }
    });
    window.addEventListener("mouseup", (event) => {
      if (event.button === 2) this.isDragging = false;
    });
    window.addEventListener("blur", () => { this.isDragging = false; });
    window.addEventListener("contextmenu", (event) => {
      if (this.enabled) event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!this.isDragging || !this.enabled) return;
      const sensitivity = this.settings.cameraSensitivity * 0.003;
      this.cameraYaw -= event.movementX * sensitivity;
      this.cameraPitch = Cesium.Math.clamp(
        this.cameraPitch + event.movementY * sensitivity,
        Cesium.Math.toRadians(-30),
        Cesium.Math.toRadians(45)
      );
    });
    window.addEventListener("wheel", (event) => {
      if (!this.enabled) return;
      this.behindDistance = Cesium.Math.clamp(
        this.behindDistance + event.deltaY * 0.08,
        this.minDistance,
        this.maxDistance
      );
      event.preventDefault();
    }, { passive: false });
  }

  reset() {
    this.travelDirection = null;
    this.cameraPosition = null;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
  }

  // Use the aircraft nose direction so the camera stays aligned through
  // pitch changes and full loops.
  follow(state, dt) {
    const position = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const ellipsoid = this.world.viewer.scene.globe.ellipsoid;
    const up = ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3());

    // Follow the full nose direction, including pitch, so the camera stays
    // behind the aircraft and looks ahead during loops and steep climbs.
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const forwardLocal = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch),
      Math.cos(state.heading) * Math.cos(state.pitch),
      Math.sin(state.pitch)
    );
    this.travelDirection = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      forwardLocal,
      this.travelDirection ?? new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.normalize(this.travelDirection, this.travelDirection);

    const right = Cesium.Cartesian3.cross(
      this.travelDirection,
      up,
      new Cesium.Cartesian3()
    );
    if (Cesium.Cartesian3.magnitudeSquared(right) < 1e-6) {
      Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, right);
    }
    Cesium.Cartesian3.normalize(right, right);
    const orbitDirection = Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(
        this.travelDirection,
        Math.cos(this.cameraYaw),
        new Cesium.Cartesian3()
      ),
      Cesium.Cartesian3.multiplyByScalar(
        right,
        Math.sin(this.cameraYaw),
        new Cesium.Cartesian3()
      ),
      new Cesium.Cartesian3()
    );
    const elevation = this.cameraElevation + this.cameraPitch;
    const horizontalOffset = Cesium.Cartesian3.multiplyByScalar(
      orbitDirection,
      -Math.cos(elevation) * this.behindDistance,
      new Cesium.Cartesian3()
    );
    const verticalOffset = Cesium.Cartesian3.multiplyByScalar(
      up,
      Math.sin(elevation) * this.behindDistance,
      new Cesium.Cartesian3()
    );
    const targetCameraPosition = Cesium.Cartesian3.add(
      position,
      horizontalOffset,
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.add(targetCameraPosition, verticalOffset, targetCameraPosition);

    const lookTarget = Cesium.Cartesian3.add(
      position,
      Cesium.Cartesian3.multiplyByScalar(this.travelDirection, 45, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const blend = this.cameraPosition
      ? 1 - Math.exp(-5 * Math.min(dt, 0.1))
      : 1;
    this.cameraPosition = this.cameraPosition
      ? Cesium.Cartesian3.lerp(this.cameraPosition, targetCameraPosition, blend, this.cameraPosition)
      : Cesium.Cartesian3.clone(targetCameraPosition);
    const direction = Cesium.Cartesian3.subtract(lookTarget, this.cameraPosition, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(direction, direction);

    // Keep the horizon level in normal flight; use the aircraft's right axis
    // as a stable fallback when the nose points almost straight up or down.
    const cameraUp = Cesium.Cartesian3.subtract(
      up,
      Cesium.Cartesian3.multiplyByScalar(
        direction,
        Cesium.Cartesian3.dot(up, direction),
        new Cesium.Cartesian3()
      ),
      new Cesium.Cartesian3()
    );
    if (Cesium.Cartesian3.magnitudeSquared(cameraUp) < 1e-6) {
      const rightLocal = new Cesium.Cartesian3(Math.cos(state.heading), -Math.sin(state.heading), 0);
      Cesium.Matrix4.multiplyByPointAsVector(enu, rightLocal, cameraUp);
    }
    Cesium.Cartesian3.normalize(cameraUp, cameraUp);

    this.world.viewer.camera.setView({
      destination: this.cameraPosition,
      orientation: { direction, up: cameraUp },
    });
  }
}

// ---------------------------------------------------------------------------
// NetworkClient — talks to the Render-hosted WebSocket relay
// ---------------------------------------------------------------------------
// Deliberately dumb: it fans messages out to callbacks and reconnects on drop.
// All game logic lives elsewhere so single-player still works with the socket
// unavailable (bad wifi, server asleep, MULTIPLAYER_URL left blank).

class NetworkClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.id = null;
    this.connected = false;
    this.players = new Map(); // id -> last known remote snapshot
    this.onRoster = () => {};
    this.onHit = () => {};
    this.onStatus = () => {};
    this._retryDelay = 1000;
    this._lastSend = 0;
  }

  connect() {
    if (!this.url) {
      this.onStatus("OFFLINE");
      return;
    }
    this.onStatus("CONNECTING");
    try {
      this.socket = new WebSocket(this.url);
    } catch (e) {
      this._scheduleRetry();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.connected = true;
      this._retryDelay = 1000;
      this.onStatus("ONLINE");
    });

    this.socket.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this._handle(msg);
    });

    this.socket.addEventListener("close", () => {
      this.connected = false;
      this.players.clear();
      this.onRoster(this.players);
      this._scheduleRetry();
    });

    // 'error' always precedes 'close', so reconnection is handled there only.
    this.socket.addEventListener("error", () => {});
  }

  _scheduleRetry() {
    this.onStatus("RECONNECTING");
    setTimeout(() => this.connect(), this._retryDelay);
    // Back off up to 15s so a sleeping free-tier Render dyno isn't hammered.
    this._retryDelay = Math.min(this._retryDelay * 1.7, 15000);
  }

  _handle(msg) {
    switch (msg.type) {
      case "welcome":
        this.id = msg.id;
        break;
      case "roster":
        this.players.clear();
        for (const p of msg.players) {
          if (p.id !== this.id) this.players.set(p.id, p);
        }
        this.onRoster(this.players);
        break;
      case "state": {
        if (msg.id === this.id) return;
        const existing = this.players.get(msg.id);
        this.players.set(msg.id, Object.assign(existing || {}, msg));
        break;
      }
      case "leave":
        this.players.delete(msg.id);
        this.onRoster(this.players);
        break;
      case "hit":
        if (msg.target === this.id) this.onHit(msg);
        break;
      default:
        break;
    }
  }

  _send(obj) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(obj));
  }

  /** Rate-limited position broadcast. Called every frame; sends at STATE_SEND_HZ. */
  sendState(state, health, alive) {
    const now = performance.now();
    if (now - this._lastSend < 1000 / STATE_SEND_HZ) return;
    this._lastSend = now;
    this._send({
      type: "state",
      lon: +state.longitude.toFixed(6),
      lat: +state.latitude.toFixed(6),
      alt: Math.round(state.height),
      hdg: +state.heading.toFixed(3),
      pit: +state.pitch.toFixed(3),
      rol: +state.roll.toFixed(3),
      spd: Math.round(state.speed),
      hp: health,
      alive,
    });
  }

  reportHit(targetId, damage) {
    this._send({ type: "hit", target: targetId, damage });
  }
}

// ---------------------------------------------------------------------------
// RemoteFleet — Cesium entities for every other player
// ---------------------------------------------------------------------------
// Network updates arrive ~15x a second but we render at 60, so each remote
// aircraft is interpolated toward its latest snapshot rather than teleporting.

class RemoteFleet {
  constructor(world, network) {
    this.world = world;
    this.network = network;
    this.entities = new Map(); // id -> { entity, smoothed }
  }

  /** Called every frame while flying. */
  update() {
    const seen = new Set();

    for (const [id, snap] of this.network.players) {
      if (snap.lon === undefined) continue;
      seen.add(id);
      let record = this.entities.get(id);

      if (!record) {
        record = {
          smoothed: { lon: snap.lon, lat: snap.lat, alt: snap.alt, hdg: snap.hdg, pit: snap.pit, rol: snap.rol },
          entity: this.world.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(snap.lon, snap.lat, snap.alt),
            model: {
              uri: AIRCRAFT_MODEL_URL,
              scale: AIRCRAFT_MODEL_SCALE,
              minimumPixelSize: 24, // stay visible as a speck at long range
              runAnimations: false,
              imageBasedLightingFactor: new Cesium.Cartesian2(MODEL_AMBIENT, MODEL_AMBIENT),
              shadows: Cesium.ShadowMode.DISABLED,
              color: Cesium.Color.fromCssColorString("#ffb3b3"),
              colorBlendMode: Cesium.ColorBlendMode.MIX,
              colorBlendAmount: 0.35,
            },
            label: {
              text: id.slice(0, 6).toUpperCase(),
              font: "12px monospace",
              fillColor: Cesium.Color.fromCssColorString("#ff5f5f"),
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
              pixelOffset: new Cesium.Cartesian2(0, -34),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000),
            },
          }),
        };
        this.entities.set(id, record);
      }

      const s = record.smoothed;
      const k = REMOTE_SMOOTHING;
      s.lon = lerpAngleDegrees(s.lon, snap.lon, k);
      s.lat += (snap.lat - s.lat) * k;
      s.alt += (snap.alt - s.alt) * k;
      s.hdg = lerpAngleRadians(s.hdg, snap.hdg, k);
      s.pit += (snap.pit - s.pit) * k;
      s.rol = lerpAngleRadians(s.rol, snap.rol, k);

      const position = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt);
      const hpr = new Cesium.HeadingPitchRoll(s.hdg - Cesium.Math.PI_OVER_TWO, s.pit, s.rol);
      record.entity.position = position;
      record.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
      record.entity.model.show = snap.alive !== false;
      record.worldPosition = position;
    }

    for (const [id, record] of this.entities) {
      if (seen.has(id)) continue;
      this.world.viewer.entities.remove(record.entity);
      this.entities.delete(id);
    }
  }

  /** Every live remote aircraft as { id, position } — used for hit testing. */
  targets() {
    const out = [];
    for (const [id, record] of this.entities) {
      if (record.worldPosition && record.entity.model.show !== false) {
        out.push({ id, position: record.worldPosition });
      }
    }
    return out;
  }

  clear() {
    for (const [, record] of this.entities) this.world.viewer.entities.remove(record.entity);
    this.entities.clear();
  }
}

// Shortest-path interpolation, so a plane crossing the 180th meridian or
// wrapping past due north doesn't whip the long way around.
function lerpAngleDegrees(from, to, k) {
  let delta = ((to - from + 540) % 360) - 180;
  return from + delta * k;
}

function lerpAngleRadians(from, to, k) {
  const TWO_PI = Math.PI * 2;
  let delta = ((to - from + Math.PI * 3) % TWO_PI) - Math.PI;
  return from + delta * k;
}

// ---------------------------------------------------------------------------
// GlobeMarkers — red dots on the start-screen globe for everyone in the air
// ---------------------------------------------------------------------------

class GlobeMarkers {
  constructor(world) {
    this.world = world;
    this.entities = new Map();
    this.visible = true;
  }

  update(players) {
    const seen = new Set();
    for (const [id, p] of players) {
      if (p.lon === undefined) continue;
      seen.add(id);
      let entity = this.entities.get(id);
      if (!entity) {
        entity = this.world.viewer.entities.add({
          point: {
            pixelSize: 11,
            color: Cesium.Color.fromCssColorString("#ff3b30"),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 2,
            // Without this, dots on the far side of the planet show through.
            heightReference: Cesium.HeightReference.NONE,
          },
        });
        this.entities.set(id, entity);
      }
      entity.position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, Math.max(p.alt, 0));
      entity.show = this.visible;
    }
    for (const [id, entity] of this.entities) {
      if (seen.has(id)) continue;
      this.world.viewer.entities.remove(entity);
      this.entities.delete(id);
    }
  }

  setVisible(visible) {
    this.visible = visible;
    for (const [, entity] of this.entities) entity.show = visible;
  }
}

// ---------------------------------------------------------------------------
// Guns — tracer rounds, hit detection, damage
// ---------------------------------------------------------------------------
// Hits are decided by the shooter and reported to the server, which is the
// cheap approach: it trusts clients. Fine for a friendly alpha; move the test
// server-side before this is worth cheating at.

class Guns {
  constructor(world, network, fleet) {
    this.world = world;
    this.network = network;
    this.fleet = fleet;
    this.bullets = [];
    this.cooldown = 0;
    this.firing = false;
    this.rounds = 0;
    this.hits = 0;

    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.firing = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false;
    });
    window.addEventListener("blur", () => (this.firing = false));
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyF") this.firing = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "KeyF") this.firing = false;
    });
  }

  update(dt, state, alive) {
    this.cooldown -= dt;
    if (this.firing && alive && this.cooldown <= 0) {
      this._fire(state);
      this.cooldown = FIRE_INTERVAL;
    }
    this._advance(dt);
  }

  _fire(state) {
    const origin = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);

    // Fire straight down the nose: heading and pitch in the local ENU frame.
    const local = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch),
      Math.cos(state.heading) * Math.cos(state.pitch),
      Math.sin(state.pitch)
    );
    const direction = Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(direction, direction);

    const aircraftVelocityLocal = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch) * state.speed,
      Math.cos(state.heading) * Math.cos(state.pitch) * state.speed,
      state.verticalSpeed
    );
    const aircraftVelocity = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      aircraftVelocityLocal,
      new Cesium.Cartesian3()
    );
    const velocity = Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(direction, BULLET_SPEED, new Cesium.Cartesian3()),
      aircraftVelocity,
      new Cesium.Cartesian3()
    );

    // Muzzle sits ahead of the nose so the tracer doesn't clip the fuselage.
    const muzzle = Cesium.Cartesian3.add(
      origin,
      Cesium.Cartesian3.multiplyByScalar(direction, 14, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

    const bullet = {
      position: Cesium.Cartesian3.clone(muzzle),
      velocity,
      distance: 0,
      life: BULLET_LIFETIME,
      tracer: this.rounds % TRACER_INTERVAL === 0,
      entity: this.world.viewer.entities.add({
        position: muzzle,
        point: {
          pixelSize: 3,
          color: this.rounds % TRACER_INTERVAL === 0
            ? Cesium.Color.fromCssColorString("#ffd68a")
            : Cesium.Color.fromCssColorString("#b8c2c8"),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
          outlineWidth: 1,
        },
        polyline: {
          positions: [muzzle, muzzle],
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: Cesium.Color.fromCssColorString("#ff9d4d").withAlpha(0.75),
            glowPower: 0.12,
          }),
          show: this.rounds % TRACER_INTERVAL === 0,
        },
      }),
    };
    this.bullets.push(bullet);
    this.rounds++;
  }

  _advance(dt) {
    const step = new Cesium.Cartesian3();
    const targets = this.fleet ? this.fleet.targets() : [];

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.life -= dt;

      const previousPosition = Cesium.Cartesian3.clone(bullet.position);
      const radialUp = this.world.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
        bullet.position,
        new Cesium.Cartesian3()
      );
      const gravity = Cesium.Cartesian3.multiplyByScalar(radialUp, -BULLET_GRAVITY, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(
        bullet.velocity,
        Cesium.Cartesian3.multiplyByScalar(gravity, dt, step),
        bullet.velocity
      );
      Cesium.Cartesian3.multiplyByScalar(bullet.velocity, dt, step);
      Cesium.Cartesian3.add(bullet.position, step, bullet.position);
      bullet.distance += Cesium.Cartesian3.distance(previousPosition, bullet.position);
      bullet.entity.position = bullet.position;
      if (bullet.tracer) {
        const trailDirection = Cesium.Cartesian3.normalize(bullet.velocity, new Cesium.Cartesian3());
        const trailStart = Cesium.Cartesian3.subtract(
          bullet.position,
          Cesium.Cartesian3.multiplyByScalar(trailDirection, TRACER_LENGTH, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
        bullet.entity.polyline.positions = [trailStart, bullet.position];
      }

      let consumed = bullet.life <= 0 || bullet.distance >= BULLET_RANGE;
      if (!consumed) {
        const cartographic = Cesium.Cartographic.fromCartesian(bullet.position);
        const groundHeight = this.world.getHeightSync(
          Cesium.Math.toDegrees(cartographic.longitude),
          Cesium.Math.toDegrees(cartographic.latitude)
        );
        if (groundHeight !== undefined && cartographic.height <= groundHeight) consumed = true;
      }

      if (!consumed) {
        const segment = Cesium.Cartesian3.subtract(
          bullet.position,
          previousPosition,
          new Cesium.Cartesian3()
        );
        const segmentLengthSquared = Cesium.Cartesian3.magnitudeSquared(segment);
        for (const target of targets) {
          const toTarget = Cesium.Cartesian3.subtract(
            target.position,
            previousPosition,
            new Cesium.Cartesian3()
          );
          const along = segmentLengthSquared > 0
            ? Cesium.Math.clamp(
              Cesium.Cartesian3.dot(toTarget, segment) / segmentLengthSquared,
              0,
              1
            )
            : 0;
          const closestPoint = Cesium.Cartesian3.add(
            previousPosition,
            Cesium.Cartesian3.multiplyByScalar(segment, along, new Cesium.Cartesian3()),
            new Cesium.Cartesian3()
          );
          if (Cesium.Cartesian3.distance(closestPoint, target.position) <= HIT_RADIUS) {
            this.network.reportHit(target.id, BULLET_DAMAGE);
            this.hits++;
            consumed = true;
            break;
          }
        }
      }

      if (consumed) {
        this.world.viewer.entities.remove(bullet.entity);
        this.bullets.splice(i, 1);
      }
    }
  }

  clear() {
    for (const bullet of this.bullets) this.world.viewer.entities.remove(bullet.entity);
    this.bullets = [];
  }
}

// ---------------------------------------------------------------------------
// MiniMap — canvas globe in the top-left corner
// ---------------------------------------------------------------------------
// An orthographic projection centred on the player: the hemisphere you're on
// is drawn, and anyone over the horizon is hidden rather than drawn flat.

class MiniMap {
  constructor() {
    this.canvas = document.getElementById("miniMap");
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.labelEl = document.getElementById("miniMapLabel");
    this.size = this.canvas ? this.canvas.width : 0;
    this.radius = this.size / 2 - 6;
  }

  show() {
    const wrap = document.getElementById("miniMapWrap");
    if (wrap) wrap.classList.remove("hidden");
  }

  /** Orthographic projection: returns null when the point is over the horizon. */
  _project(lonDeg, latDeg, centerLon, centerLat) {
    const toRad = Math.PI / 180;
    const lon = lonDeg * toRad;
    const lat = latDeg * toRad;
    const lon0 = centerLon * toRad;
    const lat0 = centerLat * toRad;

    const cosC = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
    if (cosC < 0) return null; // far side of the planet

    const x = Math.cos(lat) * Math.sin(lon - lon0);
    const y = Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
    return {
      x: this.size / 2 + x * this.radius,
      y: this.size / 2 - y * this.radius,
    };
  }

  draw(state, players) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const c = this.size / 2;
    ctx.clearRect(0, 0, this.size, this.size);

    // Ocean disc
    ctx.beginPath();
    ctx.arc(c, c, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10, 30, 52, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(90, 220, 255, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Graticule every 30 degrees, clipped to the visible hemisphere.
    ctx.strokeStyle = "rgba(90, 220, 255, 0.18)";
    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) this._drawParallel(lat, state);
    for (let lon = -180; lon < 180; lon += 30) this._drawMeridian(lon, state);

    // Equator picked out slightly brighter for orientation.
    ctx.strokeStyle = "rgba(90, 220, 255, 0.38)";
    this._drawParallel(0, state);

    // Other players
    for (const [, p] of players) {
      if (p.lon === undefined || p.alive === false) continue;
      const pt = this._project(p.lon, p.lat, state.longitude, state.latitude);
      if (!pt) continue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b30";
      ctx.fill();
    }

    // You, always dead centre, drawn as an arrow pointing along your heading.
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(state.heading);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fillStyle = "#6ff2ff";
    ctx.fill();
    ctx.restore();

    if (this.labelEl) {
      this.labelEl.textContent = `${state.latitude.toFixed(1)}° ${state.longitude.toFixed(1)}°`;
    }
  }

  _drawParallel(lat, state) {
    const ctx = this.ctx;
    let started = false;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 4) {
      const pt = this._project(lon, lat, state.longitude, state.latitude);
      if (!pt) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(pt.x, pt.y);
        started = true;
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.stroke();
  }

  _drawMeridian(lon, state) {
    const ctx = this.ctx;
    let started = false;
    ctx.beginPath();
    for (let lat = -90; lat <= 90; lat += 4) {
      const pt = this._project(lon, lat, state.longitude, state.latitude);
      if (!pt) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(pt.x, pt.y);
        started = true;
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.stroke();
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
    this.healthEl = document.getElementById("hudHealth");
    this.healthBarEl = document.getElementById("hudHealthBar");
    this.playersEl = document.getElementById("hudPlayers");
    this.netEl = document.getElementById("hudNet");
    this.yawEl = document.getElementById("hudYaw");
    this.bannerEl = document.getElementById("centerBanner");
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

  updateCombat(health, playerCount) {
    const pct = Math.max(0, Math.min(100, health));
    if (this.healthEl) this.healthEl.textContent = `${Math.round(pct)}`;
    if (this.healthBarEl) {
      this.healthBarEl.style.width = `${pct}%`;
      this.healthBarEl.style.background =
        pct > 60 ? "#4ade80" : pct > 25 ? "#fbbf24" : "#ef4444";
    }
    if (this.playersEl) this.playersEl.textContent = `${playerCount}`;
  }

  setNetStatus(status) {
    if (this.netEl) this.netEl.textContent = status;
  }

  setNoseYaw(degrees) {
    if (this.yawEl) this.yawEl.textContent = `${degrees}°`;
  }

  banner(text, durationMs = 2000) {
    if (!this.bannerEl) return;
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove("hidden");
    clearTimeout(this._bannerTimer);
    if (durationMs > 0) {
      this._bannerTimer = setTimeout(() => this.bannerEl.classList.add("hidden"), durationMs);
    }
  }

  clearBanner() {
    if (this.bannerEl) this.bannerEl.classList.add("hidden");
  }
}

class FlightSettingsMenu {
  constructor(settings, onPause, canOpen) {
    this.settings = settings;
    this.onPause = onPause;
    this.canOpen = canOpen;
    this.el = document.getElementById("settingsMenu");
    this.steeringInput = document.getElementById("steeringSensitivity");
    this.cameraInput = document.getElementById("cameraSensitivity");
    this.steeringValue = document.getElementById("steeringSensitivityValue");
    this.cameraValue = document.getElementById("cameraSensitivityValue");
    this.isOpen = false;

    this.steeringInput.value = settings.steeringSensitivity;
    this.cameraInput.value = settings.cameraSensitivity;
    this._updateLabels();

    this.steeringInput.addEventListener("input", () => {
      settings.steeringSensitivity = Number(this.steeringInput.value);
      this._updateLabels();
      settings.save();
    });
    this.cameraInput.addEventListener("input", () => {
      settings.cameraSensitivity = Number(this.cameraInput.value);
      this._updateLabels();
      settings.save();
    });
    document.getElementById("resumeFlightBtn").addEventListener("click", () => this.close());
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Escape" || event.repeat || !this.canOpen()) return;
      event.preventDefault();
      if (this.isOpen) this.close();
      else this.open();
    });
  }

  _updateLabels() {
    this.steeringValue.value = `${Number(this.steeringInput.value).toFixed(2)}×`;
    this.cameraValue.value = `${Number(this.cameraInput.value).toFixed(2)}×`;
  }

  open() {
    this.isOpen = true;
    this.el.classList.remove("hidden");
    this.onPause();
    this.steeringInput.focus();
  }

  close() {
    this.isOpen = false;
    this.el.classList.add("hidden");
    this.onPause();
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
  const settings = new FlightSettings();
  const chaseCamera = new ChaseCamera(world, settings);
  const miniMap = new MiniMap();

  const network = new NetworkClient(MULTIPLAYER_URL);
  const globeMarkers = new GlobeMarkers(world);
  const fleet = new RemoteFleet(world, network);
  const guns = new Guns(world, network, fleet);

  let flightController = null;
  let aircraft = null;
  let flying = false;
  let health = MAX_HEALTH;
  let alive = true;
  let respawnTimer = 0;
  const settingsMenu = new FlightSettingsMenu(
    settings,
    () => {
      if (flightController) flightController.keys.clear();
      guns.firing = false;
    },
    () => flying
  );

  network.onStatus = (status) => hud.setNetStatus(status);
  // Red dots on the start-screen globe show where everyone already is, so you
  // can choose to spawn into the fight or well away from it.
  network.onRoster = (players) => globeMarkers.update(players);
  network.onHit = (msg) => {
    if (!alive) return;
    health -= msg.damage ?? BULLET_DAMAGE;
    hud.banner("HIT", 600);
    if (health <= 0) killPlayer();
  };
  network.connect();

  // Nose-alignment debug keys. Should not be needed with the shipped model.
  window.addEventListener("keydown", (e) => {
    if (!aircraft) return;
    if (e.code === "BracketLeft") aircraft.setNoseYaw(MODEL_NOSE_YAW_DEGREES - 15);
    if (e.code === "BracketRight") aircraft.setNoseYaw(MODEL_NOSE_YAW_DEGREES + 15);
    if (e.code === "BracketLeft" || e.code === "BracketRight") hud.setNoseYaw(MODEL_NOSE_YAW_DEGREES);
  });

  function killPlayer() {
    alive = false;
    health = 0;
    respawnTimer = RESPAWN_DELAY;
    if (aircraft) aircraft.entity.model.show = false;
    guns.clear();
    hud.banner("DESTROYED", 0);
  }

  function respawn() {
    alive = true;
    health = MAX_HEALTH;
    if (aircraft) aircraft.entity.model.show = true;
    flightController.reset();
    chaseCamera.reset();
    hud.clearBanner();
  }

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
    flightController = new FlightController(spawnState, settings);
    chaseCamera.reset();
    chaseCamera.enabled = true;
    world.viewer.scene.screenSpaceCameraController.enableInputs = false;
    hud.show();
    hud.setNoseYaw(MODEL_NOSE_YAW_DEGREES);
    miniMap.show();
    const crosshair = document.getElementById("crosshair");
    if (crosshair) crosshair.classList.remove("hidden");
    // The start-screen dots would otherwise sit inside the other aircraft now
    // that they're drawn as real models.
    globeMarkers.setVisible(false);
    health = MAX_HEALTH;
    alive = true;
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
    if (settingsMenu.isOpen) return;

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

    if (!alive) {
      respawnTimer -= dt;
      if (respawnTimer <= 0) respawn();
    }

    aircraft.render(state);
    chaseCamera.follow(state, dt);
    hud.update(state);

    fleet.update();
    guns.update(dt, state, alive);
    network.sendState(state, health, alive);
    hud.updateCombat(health, network.players.size + 1);
    miniMap.draw(state, network.players);
  });
}

main();
