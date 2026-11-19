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
const COCKPIT_MODEL_URL = "assets/cockpit.glb";
const COCKPIT_EYE_FORWARD_OFFSET = 2.7;
const COCKPIT_EYE_HEIGHT_OFFSET = 2.05;
const SPAWN_HEIGHT_ABOVE_TERRAIN = 800; // meters — leaves room for aerobatic maneuvers
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
const MULTIPLAYER_URL = "wss://geoflight-github-io.onrender.com";
const STATE_SEND_HZ = 15;              // position updates per second
const REMOTE_SMOOTHING = 0.18;         // 0..1 — higher snaps harder to new data

// --- Combat ---------------------------------------------------------------
const MAX_HEALTH = 100;
const BULLET_DAMAGE = 12;
const LOW_HEALTH_SMOKE_THRESHOLD = 40;
const SMOKE_EMISSION_RATE = 12;
const SMOKE_PARTICLE_LIFETIME = 3;
const DEATH_SCREEN_DURATION = 3;
const EXPLOSION_PARTICLE_COUNT = 26;
const EXPLOSION_PARTICLE_LIFETIME = 1.6;
const QUICK_TURN_DURATION = 3.0;
const MAX_FLIGHT_SPEED = 3430;          // approximately Mach 10 at sea level, m/s
const BULLET_SPEED = 900;              // m/s
const BULLET_RANGE = 12000;            // meters before a round despawns
const BULLET_LIFETIME = BULLET_RANGE / BULLET_SPEED;
const FIRE_INTERVAL = 0.09;            // seconds between rounds
const GUN_HEAT_PER_SECOND = 0.38;
const GUN_COOL_PER_SECOND = 0.32;
const GUN_OVERHEAT_RECOVERY = 0.35;
const TRACER_INTERVAL = 2;             // denser tracer stream so rounds stay visible
const TRACER_LENGTH = 90;              // meters
const BULLET_GRAVITY = 9.81;           // m/s²
const HIT_RADIUS = 14;                 // meters — approximate aircraft hit radius
const MISSILE_DAMAGE = 40;
const MISSILE_LOCK_TIME = 3;
const MISSILE_LOCK_CONE = Cesium.Math.toRadians(24);
const MISSILE_LOCK_RANGE = 6000;
const MISSILE_MAX_TURN_RATE = Cesium.Math.toRadians(75);
const MISSILE_INITIAL_BOOST = 300;      // m/s added to the aircraft's velocity
const MISSILE_MAX_SPEED = 1200;
const MISSILE_ACCELERATION = 100;       // m/s²
const MISSILE_LIFETIME = 10;
const MISSILE_HIT_RADIUS = 24;
const MISSILE_STOCK = 4;
const FLARE_STOCK = 8;
const FLARE_COOLDOWN = 0.5;
const FLARE_LIFETIME = 4;
const FLARE_DECOY_RANGE = 350;

function orientationAlongDirection(direction) {
  const normalized = Cesium.Cartesian3.normalize(direction, new Cesium.Cartesian3());
  const dot = Cesium.Math.clamp(
    Cesium.Cartesian3.dot(Cesium.Cartesian3.UNIT_Z, normalized),
    -1,
    1
  );
  if (dot > 0.999999) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY);
  if (dot < -0.999999) {
    return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI);
  }
  const axis = Cesium.Cartesian3.cross(
    Cesium.Cartesian3.UNIT_Z,
    normalized,
    new Cesium.Cartesian3()
  );
  Cesium.Cartesian3.normalize(axis, axis);
  return Cesium.Quaternion.fromAxisAngle(axis, Math.acos(dot));
}

function createSmokeImage(red, green, blue) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a smoke texture.");

  const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 0.72)`);
  gradient.addColorStop(0.45, `rgba(${red}, ${green}, ${blue}, 0.42)`);
  gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

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

    if (this.ui.selectedMode === "multiplayer") {
      if (!this.ui.selectedCountry) {
        this.ui.onSpawnRejected("Choose a country before selecting a spawn point.");
        return;
      }
      if (!this.ui.countryBoundaries.contains(this.ui.selectedCountry, longitude, latitude)) {
        this.ui.onSpawnRejected(`Choose a spawn point inside ${this.ui.selectedCountry.properties.name}.`);
        return;
      }
    }

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

  clearSelection() {
    this.selectedLonLat = null;
    this.clearMarker();
    this.ui.clearSpawnSelection();
  }

  destroy() {
    this.handler.destroy();
  }
}

class CountryBoundaries {
  constructor() {
    this.features = [];
    this.byName = new Map();
  }

  async load() {
    if (this.features.length) return this.features;
    const response = await fetch("assets/countries.geojson");
    if (!response.ok) {
      throw new Error(`Could not load country boundaries (${response.status}).`);
    }
    const data = await response.json();
    if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new Error("Country boundary data is not a GeoJSON FeatureCollection.");
    }
    this.features = data.features
      .filter((feature) =>
        feature.type === "Feature" &&
        typeof feature.properties?.name === "string" &&
        feature.geometry &&
        ["Polygon", "MultiPolygon"].includes(feature.geometry.type)
      )
      .sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    if (this.features.length === 0) throw new Error("No usable country boundaries were found.");
    this.byName = new Map(this.features.map((feature) => [feature.properties.name, feature]));
    return this.features;
  }

  contains(feature, longitude, latitude) {
    if (!feature || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    return polygons.some((polygon) =>
      pointInRing(longitude, latitude, polygon[0]) &&
      !polygon.slice(1).some((hole) => pointInRing(longitude, latitude, hole))
    );
  }

  clampSegment(feature, previous, next) {
    if (this.contains(feature, next.longitude, next.latitude)) return;
    const longitudeDelta = ((next.longitude - previous.longitude + 540) % 360) - 180;
    let inside = 0;
    let outside = 1;
    for (let i = 0; i < 24; i += 1) {
      const progress = (inside + outside) / 2;
      const longitude = ((previous.longitude + longitudeDelta * progress + 540) % 360) - 180;
      const latitude = previous.latitude + (next.latitude - previous.latitude) * progress;
      if (this.contains(feature, longitude, latitude)) inside = progress;
      else outside = progress;
    }
    next.longitude = ((previous.longitude + longitudeDelta * inside + 540) % 360) - 180;
    next.latitude = previous.latitude + (next.latitude - previous.latitude) * inside;
  }
}

function pointInRing(longitude, latitude, ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const points = [];
  let previousLongitude = ring[0][0];
  for (const [rawLongitude, pointLatitude] of ring) {
    let pointLongitude = rawLongitude;
    while (pointLongitude - previousLongitude > 180) pointLongitude -= 360;
    while (pointLongitude - previousLongitude < -180) pointLongitude += 360;
    points.push([pointLongitude, pointLatitude]);
    previousLongitude = pointLongitude;
  }
  const centerLongitude = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const testLongitude = longitude + 360 * Math.round((centerLongitude - longitude) / 360);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const cross = (testLongitude - xi) * (yj - yi) - (latitude - yi) * (xj - xi);
    if (
      Math.abs(cross) < 1e-8 &&
      testLongitude >= Math.min(xi, xj) &&
      testLongitude <= Math.max(xi, xj) &&
      latitude >= Math.min(yi, yj) &&
      latitude <= Math.max(yi, yj)
    ) return true;
    if ((yi > latitude) !== (yj > latitude) &&
        testLongitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
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
    this.fieldOfView = this._readValue(saved.fieldOfView, 70, 50, 100);
  }

  _readValue(value, fallback, min, max) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Cesium.Math.clamp(numericValue, min, max) : fallback;
  }

  save() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      steeringSensitivity: this.steeringSensitivity,
      cameraSensitivity: this.cameraSensitivity,
      fieldOfView: this.fieldOfView,
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
    // The cockpit faces opposite the aircraft; rotate around Cesium's local
    // Z-up axis so it faces forward without flipping its vertical axis.
    this.cockpitAlignment = Cesium.Quaternion.fromAxisAngle(
      Cesium.Cartesian3.UNIT_Z,
      Math.PI,
      new Cesium.Quaternion()
    );
    this.cockpitOrientation = new Cesium.Quaternion();

    this.entity = world.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      model: {
        uri: modelUrl,
        scale: AIRCRAFT_MODEL_SCALE,
        minimumPixelSize: 32,
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
    this.entity.model.show = false;
    this.cockpitEntity = world.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      model: {
        uri: COCKPIT_MODEL_URL,
        scale: AIRCRAFT_MODEL_SCALE,
        minimumPixelSize: 0,
        runAnimations: false,
        imageBasedLightingFactor: new Cesium.Cartesian2(MODEL_AMBIENT, MODEL_AMBIENT),
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
    this.world.viewer.entities.remove(this.cockpitEntity);
  }

  setFirstPerson(enabled) {
    this.entity.model.show = !enabled;
    this.cockpitEntity.model.show = enabled;
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
    this.cockpitEntity.position = position;
    Cesium.Quaternion.multiply(
      worldOrientation,
      this.cockpitAlignment,
      this.cockpitOrientation
    );
    this.cockpitEntity.orientation = this.cockpitOrientation;
  }
}

class DamageSmoke {
  constructor(world) {
    this.collection = world.viewer.scene.primitives.add(new Cesium.BillboardCollection());
    this.particles = [];
    this.emissionRemainder = 0;

    this.image = createSmokeImage(58, 58, 58);
  }

  update(dt, state, enabled) {
    this._advance(dt);
    if (!enabled) return;

    this.emissionRemainder += dt * SMOKE_EMISSION_RATE;
    while (this.emissionRemainder >= 1) {
      this.emissionRemainder -= 1;
      this._emit(state);
    }
  }

  clear() {
    for (const particle of this.particles) this.collection.remove(particle.billboard);
    this.particles.length = 0;
    this.emissionRemainder = 0;
  }

  _advance(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.age += dt;
      if (particle.age >= particle.lifetime) {
        this.collection.remove(particle.billboard);
        this.particles.splice(i, 1);
        continue;
      }

      Cesium.Cartesian3.add(
        particle.position,
        Cesium.Cartesian3.multiplyByScalar(particle.velocity, dt, new Cesium.Cartesian3()),
        particle.position
      );
      const progress = particle.age / particle.lifetime;
      particle.billboard.position = particle.position;
      particle.billboard.scale = 0.7 + progress * 2;
      particle.billboard.color = Cesium.Color.WHITE.withAlpha(0.62 * (1 - progress) ** 1.5);
    }
  }

  _emit(state) {
    const position = Cesium.Cartesian3.fromDegrees(
      state.longitude,
      state.latitude,
      state.height
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const localForward = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch),
      Math.cos(state.heading) * Math.cos(state.pitch),
      Math.sin(state.pitch)
    );
    const forward = Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(enu, localForward, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      position,
      new Cesium.Cartesian3()
    );
    const right = Cesium.Cartesian3.cross(forward, up, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.magnitudeSquared(right) < 1e-6) {
      Cesium.Matrix4.multiplyByPointAsVector(enu, Cesium.Cartesian3.UNIT_X, right);
    }
    Cesium.Cartesian3.normalize(right, right);

    const localVelocity = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch) * state.speed,
      Math.cos(state.heading) * Math.cos(state.pitch) * state.speed,
      state.verticalSpeed
    );
    const aircraftVelocity = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      localVelocity,
      new Cesium.Cartesian3()
    );
    const tailPosition = Cesium.Cartesian3.add(
      Cesium.Cartesian3.subtract(
        position,
        Cesium.Cartesian3.multiplyByScalar(forward, 18, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      ),
      Cesium.Cartesian3.multiplyByScalar(up, 2, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const lateralOffset = (Math.random() - 0.5) * 5;
    const particlePosition = Cesium.Cartesian3.add(
      tailPosition,
      Cesium.Cartesian3.multiplyByScalar(right, lateralOffset, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const velocity = Cesium.Cartesian3.multiplyByScalar(
      aircraftVelocity,
      0.82,
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.add(
      velocity,
      Cesium.Cartesian3.multiplyByScalar(up, 4 + Math.random() * 4, new Cesium.Cartesian3()),
      velocity
    );
    Cesium.Cartesian3.add(
      velocity,
      Cesium.Cartesian3.multiplyByScalar(right, lateralOffset, new Cesium.Cartesian3()),
      velocity
    );

    const billboard = this.collection.add({
      position: particlePosition,
      image: this.image,
      width: 8,
      height: 8,
      sizeInMeters: true,
      color: Cesium.Color.WHITE.withAlpha(0.62),
    });
    this.particles.push({
      billboard,
      position: particlePosition,
      velocity,
      age: 0,
      lifetime: SMOKE_PARTICLE_LIFETIME * (0.75 + Math.random() * 0.5),
    });
  }
}

class AircraftExplosion {
  constructor(world) {
    this.collection = world.viewer.scene.primitives.add(new Cesium.BillboardCollection());
    this.particles = [];
    this.image = this._createImage();
    this.colors = [
      Cesium.Color.fromCssColorString("#fff4b0"),
      Cesium.Color.fromCssColorString("#ffb02e"),
      Cesium.Color.fromCssColorString("#ff5a1f"),
      Cesium.Color.fromCssColorString("#b82916"),
    ];
  }

  start(state) {
    this.clear();
    const origin = Cesium.Cartesian3.fromDegrees(
      state.longitude,
      state.latitude,
      state.height
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      origin,
      new Cesium.Cartesian3()
    );
    const localVelocity = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch) * state.speed,
      Math.cos(state.heading) * Math.cos(state.pitch) * state.speed,
      state.verticalSpeed
    );
    const inheritedVelocity = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Matrix4.multiplyByPointAsVector(enu, localVelocity, new Cesium.Cartesian3()),
      0.25,
      new Cesium.Cartesian3()
    );

    for (let i = 0; i < EXPLOSION_PARTICLE_COUNT; i++) {
      const localDirection = Cesium.Cartesian3.normalize(
        new Cesium.Cartesian3(
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
          0.2 + Math.random() * 1.3
        ),
        new Cesium.Cartesian3()
      );
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Matrix4.multiplyByPointAsVector(enu, localDirection, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const position = Cesium.Cartesian3.add(
        origin,
        Cesium.Cartesian3.multiplyByScalar(direction, Math.random() * 6, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const velocity = Cesium.Cartesian3.add(
        inheritedVelocity,
        Cesium.Cartesian3.multiplyByScalar(
          direction,
          25 + Math.random() * 45,
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      Cesium.Cartesian3.add(
        velocity,
        Cesium.Cartesian3.multiplyByScalar(up, 6 + Math.random() * 12, new Cesium.Cartesian3()),
        velocity
      );

      const color = this.colors[i % this.colors.length];
      const billboard = this.collection.add({
        position,
        image: this.image,
        width: 10 + Math.random() * 10,
        height: 10 + Math.random() * 10,
        sizeInMeters: true,
        color: color.withAlpha(0.95),
      });
      this.particles.push({
        billboard,
        color,
        position,
        velocity,
        gravity: Cesium.Cartesian3.multiplyByScalar(up, -24, new Cesium.Cartesian3()),
        age: 0,
        lifetime: EXPLOSION_PARTICLE_LIFETIME * (0.65 + Math.random() * 0.35),
      });
    }
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.age += dt;
      if (particle.age >= particle.lifetime) {
        this.collection.remove(particle.billboard);
        this.particles.splice(i, 1);
        continue;
      }

      Cesium.Cartesian3.add(
        particle.velocity,
        Cesium.Cartesian3.multiplyByScalar(
          particle.gravity,
          dt,
          new Cesium.Cartesian3()
        ),
        particle.velocity
      );
      Cesium.Cartesian3.add(
        particle.position,
        Cesium.Cartesian3.multiplyByScalar(
          particle.velocity,
          dt,
          new Cesium.Cartesian3()
        ),
        particle.position
      );
      const progress = particle.age / particle.lifetime;
      particle.billboard.position = particle.position;
      particle.billboard.scale = 0.8 + progress * 1.5;
      particle.billboard.color = particle.color.withAlpha(0.95 * (1 - progress));
    }
  }

  clear() {
    for (const particle of this.particles) this.collection.remove(particle.billboard);
    this.particles.length = 0;
  }

  _createImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the aircraft explosion texture.");

    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255, 255, 230, 1)");
    gradient.addColorStop(0.2, "rgba(255, 190, 45, 0.95)");
    gradient.addColorStop(0.55, "rgba(235, 65, 20, 0.72)");
    gradient.addColorStop(1, "rgba(110, 20, 0, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
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
    this.quickTurnRemaining = 0;
    this.quickTurnDirection = 1;
    this.quickTurnStartRoll = 0;
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
    this.maxTurnLoadFactor = 6;
    this.maxTurnRate = Cesium.Math.toRadians(65);
    this.minSpeed = 0;          // braking can bring a landed aircraft to rest
    this.maxSpeed = MAX_FLIGHT_SPEED;
    this.throttleRate = 1;
    this.maxThrustAcceleration = 1100;
    this.dragCoefficient = 0.08;
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
    if (!document.getElementById("settingsMenu").classList.contains("hidden")) {
      this.keys.delete(e.code);
      return;
    }
    if (e.code === "KeyQ") {
      if (isDown && !e.repeat && this.quickTurnRemaining <= 0) {
        this.quickTurnDirection = Math.sign(Math.sin(this.state.roll)) || 1;
        this.quickTurnStartRoll = this.state.roll;
        this.quickTurnRemaining = QUICK_TURN_DURATION;
      }
      return;
    }
    this.keys[isDown ? "add" : "delete"](e.code);
  }

  reset() {
    this.state = this.spawnState.clone();
    this.keys.delete("KeyR");
    this.quickTurnRemaining = 0;
    this.quickTurnStartRoll = this.state.roll;
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
    const quickTurnActive = this.quickTurnRemaining > 0;
    if (quickTurnActive) rollInput = 0;

    const braking = k.has("ControlLeft") || k.has("ControlRight") ||
      k.has("ArrowDown") || k.has("KeyK");

    // Integrate angular velocity instead of snapping directly to an angle.
    // The self-leveling term is deliberately weak: it feels like a stable jet,
    // not a camera that forcibly pops upright when a key is released.
    const steeringSensitivity = this.settings.steeringSensitivity;
    s.pitchRate += pitchInput * this.pitchAcceleration * steeringSensitivity * dt;
    s.rollRate += rollInput * this.rollAcceleration * steeringSensitivity * dt;
    if (k.has("KeyX")) {
      s.pitchRate += (
        Cesium.Math.negativePiToPi(-s.pitch) * 3.5 - s.pitchRate * 2.4
      ) * dt;
      s.rollRate += (
        Cesium.Math.negativePiToPi(-s.roll) * 3.5 - s.rollRate * 2.4
      ) * dt;
    }
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

    // Bank drives a combat-assisted turn, with capped effective airspeed to
    // keep hard reversals responsive even at higher flight speeds.
    const turnBank = Cesium.Math.clamp(
      Math.asin(Math.sin(s.roll)),
      -this.turnBankLimit,
      this.turnBankLimit
    );
    if (quickTurnActive) {
      const step = Math.min(dt, this.quickTurnRemaining);
      const remainingAfter = Math.max(0, this.quickTurnRemaining - step);
      const progress = 1 - remainingAfter / QUICK_TURN_DURATION;
      const targetRoll = this.quickTurnStartRoll +
        this.quickTurnDirection * this.turnBankLimit * Math.sin(Math.PI * progress);
      const rollError = Cesium.Math.negativePiToPi(targetRoll - s.roll);
      s.roll = Cesium.Math.negativePiToPi(targetRoll);
      s.rollRate = remainingAfter > 0 && dt > 0 ? rollError / dt : 0;
      s.heading += this.quickTurnDirection * Math.PI * (step / QUICK_TURN_DURATION);
      this.quickTurnRemaining = remainingAfter;
    } else if (Math.abs(turnBank) > Cesium.Math.toRadians(0.5)) {
      // Combat handling caps the effective airspeed so hard bank reversals
      // stay responsive without allowing an unbounded turn rate.
      const airbrakeTurnBoost = braking ? 1.2 : 1;
      const turnAcceleration = Math.min(
        Math.abs(this.bankTurnStrength * Math.tan(turnBank)) * airbrakeTurnBoost * 1.5,
        this.maxTurnLoadFactor * 9.81
      );
      const turnSpeed = Math.max(5, Math.min(s.speed, 90));
      const turnRate = Cesium.Math.clamp(
        Math.sign(turnBank) * turnAcceleration / turnSpeed,
        -this.maxTurnRate * steeringSensitivity,
        this.maxTurnRate * steeringSensitivity
      );
      s.heading += turnRate * dt;
    }

    // Keep the heading bounded. This avoids losing precision during long
    // flights while preserving Cesium's clockwise-from-north convention.
    s.heading = Cesium.Math.negativePiToPi(s.heading);

    // --- Throttle / speed ---
    // Shift increases engine power. Ctrl or Down lowers power and adds
    // wheel-brake force, allowing a landed aircraft to stop completely.
    if (
      k.has("ShiftLeft") || k.has("ShiftRight") || k.has("ArrowUp") || k.has("KeyI")
    ) {
      s.throttle += this.throttleRate * dt;
    }
    if (braking) s.throttle -= this.throttleRate * dt * 1.8;
    s.throttle = Cesium.Math.clamp(s.throttle, 0, 1);
    // Thrust and drag, rather than a forced target speed, set the airspeed.
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
    if (groundHeight === undefined) return false; // terrain tile not loaded yet at this spot
    const s = this.state;
    const minHeight = groundHeight + MIN_TERRAIN_CLEARANCE;
    if (s.height < minHeight) {
      const impact = s.verticalSpeed < 0;
      s.height = minHeight;
      if (s.verticalSpeed < 0) s.verticalSpeed = 0;
      if (s.pitch < 0) s.pitch = 0; // stop nosing further into the ground
      s.speed = Math.max(this.minSpeed, s.speed * 0.985); // slight speed scrub on contact
      return impact;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// ChaseCamera — cockpit view with a third-person inspection camera
// ---------------------------------------------------------------------------

class ChaseCamera {
  constructor(world, settings) {
    this.world = world;
    this.settings = settings;
    this.canvas = world.viewer.scene.canvas;
    this.behindDistance = 72;
    this.cameraYaw = 0;
    this.cameraPitch = 0;
    this.cameraElevation = Cesium.Math.toRadians(24);
    this.minDistance = 25;
    this.maxDistance = 180;
    this.firstPerson = true;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.enabled = false;
    this.cameraPosition = null;
    this.travelDirection = null; // world-space unit vector aligned with the aircraft nose
    this.applyFieldOfView();

    this.canvas.addEventListener("click", () => {
      if (
        this.enabled &&
        document.getElementById("settingsMenu").classList.contains("hidden")
      ) this.lockPointer();
    });
    window.addEventListener("mousemove", (event) => {
      if (
        !this.enabled ||
        !document.getElementById("settingsMenu").classList.contains("hidden")
      ) return;
      const sensitivity = this.settings.cameraSensitivity * 0.003;
      if (this.firstPerson) {
        this.lookYaw = Cesium.Math.negativePiToPi(this.lookYaw + event.movementX * sensitivity);
        this.lookPitch = Cesium.Math.clamp(
          this.lookPitch - event.movementY * sensitivity,
          Cesium.Math.toRadians(-65),
          Cesium.Math.toRadians(65)
        );
      } else {
        this.cameraYaw -= event.movementX * sensitivity;
        this.cameraPitch = Cesium.Math.clamp(
          this.cameraPitch + event.movementY * sensitivity,
          Cesium.Math.toRadians(-30),
          Cesium.Math.toRadians(45)
        );
      }
    });
    window.addEventListener("wheel", (event) => {
      if (!this.enabled || this.firstPerson) return;
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
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  lockPointer() {
    if (
      typeof this.canvas.requestPointerLock !== "function" ||
      document.pointerLockElement === this.canvas
    ) return;
    try {
      const request = this.canvas.requestPointerLock();
      if (request && typeof request.catch === "function") {
        request.catch((error) => console.warn("Could not lock the flight cursor.", error));
      }
    } catch (error) {
      console.warn("Could not lock the flight cursor.", error);
    }
  }

  unlockPointer() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  applyFieldOfView() {
    this.world.viewer.camera.frustum.fov = Cesium.Math.toRadians(this.settings.fieldOfView);
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

    if (this.firstPerson) {
      // Derive the cockpit up axis from pitch directly; projecting world up
      // loses its direction when the aircraft points straight up in a loop.
      const horizontalForward = Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        new Cesium.Cartesian3(Math.sin(state.heading), Math.cos(state.heading), 0),
        new Cesium.Cartesian3()
      );
      const aircraftUp = Cesium.Cartesian3.subtract(
        Cesium.Cartesian3.multiplyByScalar(up, Math.cos(state.pitch), new Cesium.Cartesian3()),
        Cesium.Cartesian3.multiplyByScalar(
          horizontalForward,
          Math.sin(state.pitch),
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      Cesium.Cartesian3.normalize(aircraftUp, aircraftUp);
      const rollRotation = Cesium.Quaternion.fromAxisAngle(
        this.travelDirection,
        state.roll,
        new Cesium.Quaternion()
      );
      const rolledUp = Cesium.Matrix3.multiplyByVector(
        Cesium.Matrix3.fromQuaternion(rollRotation, new Cesium.Matrix3()),
        aircraftUp,
        new Cesium.Cartesian3()
      );
      const right = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.cross(this.travelDirection, rolledUp, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const yawDirection = Cesium.Cartesian3.add(
        Cesium.Cartesian3.multiplyByScalar(
          this.travelDirection,
          Math.cos(this.lookYaw),
          new Cesium.Cartesian3()
        ),
        Cesium.Cartesian3.multiplyByScalar(
          right,
          Math.sin(this.lookYaw),
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      const direction = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.add(
          Cesium.Cartesian3.multiplyByScalar(
            yawDirection,
            Math.cos(this.lookPitch),
            new Cesium.Cartesian3()
          ),
          Cesium.Cartesian3.multiplyByScalar(
            rolledUp,
            Math.sin(this.lookPitch),
            new Cesium.Cartesian3()
          ),
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      const cameraRight = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.cross(direction, rolledUp, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const cameraUp = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.cross(cameraRight, direction, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      const cameraPosition = Cesium.Cartesian3.add(
        position,
        Cesium.Cartesian3.multiplyByScalar(
          this.travelDirection,
          COCKPIT_EYE_FORWARD_OFFSET,
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      Cesium.Cartesian3.add(
        cameraPosition,
        Cesium.Cartesian3.multiplyByScalar(
          rolledUp,
          COCKPIT_EYE_HEIGHT_OFFSET,
          new Cesium.Cartesian3()
        ),
        cameraPosition
      );
      this.world.viewer.camera.setView({
        destination: cameraPosition,
        orientation: { direction, up: cameraUp },
      });
      this.cameraPosition = cameraPosition;
      return;
    }

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
    this.country = null;
    this.connected = false;
    this.players = new Map(); // id -> last known remote snapshot
    this.onRoster = () => {};
    this.onHit = () => {};
    this.onStatus = () => {};
    this.onRoomStatus = () => {};
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
      if (this.country) this._send({ type: "join-country", country: this.country });
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
      case "roster": {
        const present = new Set();
        for (const p of msg.players) {
          if (p.id === this.id) continue;
          present.add(p.id);
          const current = this.players.get(p.id);
          this.players.set(p.id, Object.assign(current || {}, p));
        }
        for (const id of this.players.keys()) {
          if (!present.has(id)) this.players.delete(id);
        }
        this.onRoster(this.players);
        break;
      }
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
      case "room-status":
        this.onRoomStatus(msg);
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

  joinCountry(country) {
    if (typeof country !== "string" || country.length === 0) return;
    if (this.country === country) return;
    this.country = country;
    this.players.clear();
    this.onRoster(this.players);
    this._send({ type: "join-country", country });
  }

  leaveCountry() {
    if (this.country && this.connected) this._send({ type: "leave-country" });
    this.country = null;
    this.players.clear();
    this.onRoster(this.players);
    this.onRoomStatus({ country: null, count: 0 });
  }

  /** Rate-limited position broadcast. Called every frame; sends at STATE_SEND_HZ. */
  sendState(state, health, alive, ordnance, force = false) {
    const now = performance.now();
    if (!force && now - this._lastSend < 1000 / STATE_SEND_HZ) return;
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
      bullets: ordnance.bullets,
      missiles: ordnance.missiles,
      flares: ordnance.flares,
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
    this.flareSmokeImage = createSmokeImage(235, 32, 38);
    this.entities = new Map(); // id -> { entity, smoothed }
    this.ordnance = new Map();
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
              minimumPixelSize: 32,
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
    this._syncOrdnance();
  }

  _syncOrdnance() {
    const seen = new Set();
    for (const [ownerId, player] of this.network.players) {
      for (const [kind, items] of [
        ["bullet", player.bullets || []],
        ["missile", player.missiles || []],
        ["flare", player.flares || []],
      ]) {
        for (const item of items) {
          if (item.lon === undefined || item.id === undefined) continue;
          const key = `${ownerId}:${kind}:${item.id}`;
          seen.add(key);
          let record = this.ordnance.get(key);
          if (!record) {
            const isBullet = kind === "bullet";
            const isMissile = kind === "missile";
            const isFlare = kind === "flare";
            record = {
              snapshot: null,
              position: null,
              receivedAt: 0,
              entity: this.world.viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.alt),
                ...(isBullet ? {
                  point: {
                    pixelSize: 4,
                    color: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.fromCssColorString("#ffb53d"),
                    outlineWidth: 1,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  },
                } : isMissile ? {
                  cylinder: {
                    length: 4.5,
                    topRadius: 0,
                    bottomRadius: 0.22,
                    material: Cesium.Color.fromCssColorString("#d9e1e8"),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString("#35424c"),
                  },
                } : isFlare ? {
                  billboard: {
                    image: this.flareSmokeImage,
                    width: 36,
                    height: 36,
                    color: Cesium.Color.WHITE.withAlpha(0.8),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    scaleByDistance: new Cesium.NearFarScalar(500, 1, 100000, 0.35),
                  },
                } : {}),
                polyline: {
                  positions: [],
                  width: isBullet ? 2 : isMissile ? 3 : 6,
                  material: new Cesium.PolylineGlowMaterialProperty({
                    color: isBullet
                      ? Cesium.Color.fromCssColorString("#fff3c4").withAlpha(0.95)
                      : isMissile
                        ? Cesium.Color.fromCssColorString("#ff6b35").withAlpha(0.75)
                        : Cesium.Color.fromCssColorString("#e52f39").withAlpha(0.42),
                    glowPower: isBullet ? 0.08 : isMissile ? 0.12 : 0.32,
                  }),
                  show: true,
                },
              }),
            };
            this.ordnance.set(key, record);
          }

          const isBullet = kind === "bullet";
          if (isBullet && record.snapshot !== item) {
            record.snapshot = item;
            record.position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.alt);
            record.receivedAt = performance.now();
          }
          const position = isBullet && item.vel
            ? this._extrapolateBullet(record, item)
            : Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.alt);
          record.entity.position = position;
          const direction = isBullet && item.vel
            ? Cesium.Cartesian3.normalize(
              Cesium.Cartesian3.fromElements(item.vel[0], item.vel[1], item.vel[2]),
              new Cesium.Cartesian3()
            )
            : item.dir
            ? Cesium.Cartesian3.fromElements(item.dir[0], item.dir[1], item.dir[2])
            : Cesium.Cartesian3.UNIT_Z;
          if (kind !== "flare") record.entity.orientation = orientationAlongDirection(direction);
          const trailStart = Cesium.Cartesian3.subtract(
            position,
            Cesium.Cartesian3.multiplyByScalar(
              direction,
              isBullet ? TRACER_LENGTH : kind === "missile" ? 9 : 24,
              new Cesium.Cartesian3()
            ),
            new Cesium.Cartesian3()
          );
          record.entity.polyline.positions = [trailStart, position];
        }
      }
    }

    for (const [key, record] of this.ordnance) {
      if (seen.has(key)) continue;
      this.world.viewer.entities.remove(record.entity);
      this.ordnance.delete(key);
    }
  }

  _extrapolateBullet(record, item) {
    const elapsed = Math.min((performance.now() - record.receivedAt) / 1000, 0.2);
    const velocity = Cesium.Cartesian3.fromElements(item.vel[0], item.vel[1], item.vel[2]);
    const displacement = Cesium.Cartesian3.multiplyByScalar(
      velocity,
      elapsed,
      new Cesium.Cartesian3()
    );
    const position = Cesium.Cartesian3.add(record.position, displacement, new Cesium.Cartesian3());
    const up = this.world.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
      record.position,
      new Cesium.Cartesian3()
    );
    const gravity = Cesium.Cartesian3.multiplyByScalar(up, -BULLET_GRAVITY, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(
      position,
      Cesium.Cartesian3.multiplyByScalar(gravity, 0.5 * elapsed * elapsed, new Cesium.Cartesian3()),
      position
    );
    return position;
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
    for (const [, record] of this.ordnance) this.world.viewer.entities.remove(record.entity);
    this.ordnance.clear();
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
// Weapons — gun rounds, missiles, flares, hit detection, damage
// ---------------------------------------------------------------------------
// Hits are decided by the shooter and reported to the server, which is the
// cheap approach: it trusts clients. Fine for a friendly alpha; move the test
// server-side before this is worth cheating at.

class Guns {
  constructor(world, network, fleet) {
    this.world = world;
    this.network = network;
    this.fleet = fleet;
    this.flareSmokeImage = createSmokeImage(235, 32, 38);
    this.bullets = [];
    this.cooldown = 0;
    this.firing = false;
    this.fireRequested = false;
    this.gunHeat = 0;
    this.gunOverheated = false;
    this.rounds = 0;
    this.hits = 0;
    this.missiles = [];
    this.flares = [];
    this.missilesRemaining = MISSILE_STOCK;
    this.flaresRemaining = FLARE_STOCK;
    this.missileSequence = 0;
    this.flareCooldown = 0;
    this.lockTargetId = null;
    this.lockProgress = 0;
    this.lockBeepPlayed = false;
    this.missileRequested = false;
    this.flareRequested = false;
    this.flightMenuEl = document.getElementById("settingsMenu");
    this.audioContext = null;

    window.addEventListener("pointerdown", (e) => {
      if (e.isPrimary && e.button === 0 &&
          this.flightMenuEl.classList.contains("hidden")) {
        this.firing = true;
        this.fireRequested = true;
      }
    }, true);
    window.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.firing = false;
    }, true);
    window.addEventListener("pointercancel", () => {
      this.firing = false;
    }, true);
    window.addEventListener("blur", () => this.cancelPendingActions());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.cancelPendingActions();
    });
    window.addEventListener("keydown", (e) => {
      this._unlockAudio();
      if (!this.flightMenuEl.classList.contains("hidden")) return;
      if (e.code === "KeyF" && !e.repeat) this.missileRequested = true;
      if (e.code === "KeyC" && !e.repeat) this.flareRequested = true;
    });
  }

  update(dt, state, alive) {
    this.cooldown -= dt;
    this.flareCooldown = Math.max(0, this.flareCooldown - dt);
    this._updateLock(dt, state, alive);

    if (this.missileRequested) {
      if (alive && this.lockProgress >= MISSILE_LOCK_TIME && this.missilesRemaining > 0) {
        this._launchMissile(state);
      }
      this.missileRequested = false;
    }
    if (this.flareRequested) {
      if (alive && this.flaresRemaining > 0 && this.flareCooldown <= 0) {
        this._releaseFlare(state);
      }
      this.flareRequested = false;
    }

    const shouldFire = this.firing || this.fireRequested;
    this.fireRequested = false;
    if (shouldFire && alive) {
      if (this.gunOverheated) {
        this.gunHeat = Math.max(0, this.gunHeat - GUN_COOL_PER_SECOND * dt);
        if (this.gunHeat <= GUN_OVERHEAT_RECOVERY) this.gunOverheated = false;
      } else {
        this.gunHeat = Math.min(1, this.gunHeat + GUN_HEAT_PER_SECOND * dt);
        if (this.cooldown <= 0) {
          this._fire(state);
          this.cooldown = FIRE_INTERVAL;
        }
        if (this.gunHeat >= 1) this.gunOverheated = true;
      }
    } else {
      this.gunHeat = Math.max(0, this.gunHeat - GUN_COOL_PER_SECOND * dt);
      if (this.gunHeat <= GUN_OVERHEAT_RECOVERY) this.gunOverheated = false;
    }
    this._advance(dt);
    this._advanceMissiles(dt);
    this._advanceFlares(dt);
  }

  cancelPendingActions() {
    this.firing = false;
    this.fireRequested = false;
    this.missileRequested = false;
    this.flareRequested = false;
  }

  resetLoadout() {
    this.missilesRemaining = MISSILE_STOCK;
    this.flaresRemaining = FLARE_STOCK;
    this.gunHeat = 0;
    this.gunOverheated = false;
    this.flareCooldown = 0;
    this.lockTargetId = null;
    this.lockProgress = 0;
    this.lockBeepPlayed = false;
    this.cancelPendingActions();
  }

  getNetworkOrdnance() {
    const snapshot = (items) => items.map((item) => {
      const position = Cesium.Cartographic.fromCartesian(item.position);
      const direction = Cesium.Cartesian3.normalize(item.velocity, new Cesium.Cartesian3());
      return {
        id: item.id,
        lon: Cesium.Math.toDegrees(position.longitude),
        lat: Cesium.Math.toDegrees(position.latitude),
        alt: position.height,
        dir: [direction.x, direction.y, direction.z],
      };
    });
    const bulletSnapshots = this.bullets.map((bullet) => {
      const position = Cesium.Cartographic.fromCartesian(bullet.position);
      return {
        id: bullet.id,
        lon: Cesium.Math.toDegrees(position.longitude),
        lat: Cesium.Math.toDegrees(position.latitude),
        alt: position.height,
        vel: [bullet.velocity.x, bullet.velocity.y, bullet.velocity.z],
        tracer: bullet.tracer,
      };
    });
    return {
      bullets: bulletSnapshots,
      missiles: snapshot(this.missiles),
      flares: snapshot(this.flares),
    };
  }

  _flightDirection(state, position) {
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const localDirection = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch),
      Math.cos(state.heading) * Math.cos(state.pitch),
      Math.sin(state.pitch)
    );
    const direction = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      localDirection,
      new Cesium.Cartesian3()
    );
    return Cesium.Cartesian3.normalize(direction, direction);
  }

  _aircraftVelocity(state, position) {
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
    const localVelocity = new Cesium.Cartesian3(
      Math.sin(state.heading) * Math.cos(state.pitch) * state.speed,
      Math.cos(state.heading) * Math.cos(state.pitch) * state.speed,
      state.verticalSpeed
    );
    return Cesium.Matrix4.multiplyByPointAsVector(enu, localVelocity, new Cesium.Cartesian3());
  }

  _updateLock(dt, state, alive) {
    if (!alive || !this.fleet) {
      this.lockTargetId = null;
      this.lockProgress = 0;
      this.lockBeepPlayed = false;
      return;
    }

    const origin = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const forward = this._flightDirection(state, origin);
    const minimumDot = Math.cos(MISSILE_LOCK_CONE);
    let bestTarget = null;
    let bestDot = minimumDot;
    for (const target of this.fleet.targets()) {
      const toTarget = Cesium.Cartesian3.subtract(
        target.position,
        origin,
        new Cesium.Cartesian3()
      );
      const distance = Cesium.Cartesian3.magnitude(toTarget);
      if (distance > MISSILE_LOCK_RANGE || distance < 1) continue;
      Cesium.Cartesian3.divideByScalar(toTarget, distance, toTarget);
      const aimDot = Cesium.Cartesian3.dot(forward, toTarget);
      if (aimDot > bestDot) {
        bestDot = aimDot;
        bestTarget = target;
      }
    }

    if (!bestTarget) {
      this.lockTargetId = null;
      this.lockProgress = 0;
      this.lockBeepPlayed = false;
    } else if (bestTarget.id === this.lockTargetId) {
      this.lockProgress = Math.min(MISSILE_LOCK_TIME, this.lockProgress + dt);
      if (this.lockProgress >= MISSILE_LOCK_TIME && !this.lockBeepPlayed) {
        this.lockBeepPlayed = true;
        this._playLockBeep();
      }
    } else {
      this.lockTargetId = bestTarget.id;
      this.lockProgress = 0;
      this.lockBeepPlayed = false;
    }
  }

  _unlockAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!this.audioContext) this.audioContext = new AudioContextClass();
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch((error) => {
        console.warn("Missile lock audio could not be enabled.", error);
      });
    }
  }

  _playLockBeep() {
    this._unlockAudio();
    if (!this.audioContext) return;
    const play = () => {
      const now = this.audioContext.currentTime;
      const oscillator = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      oscillator.connect(gain);
      gain.connect(this.audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.17);
    };
    if (this.audioContext.state === "running") play();
    else {
      this.audioContext.resume().then(play).catch((error) => {
        console.warn("Missile lock beep could not be played.", error);
      });
    }
  }

  _launchMissile(state) {
    const target = this.fleet.targets().find((item) => item.id === this.lockTargetId);
    if (!target || this.missilesRemaining <= 0) return;

    const origin = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const direction = this._flightDirection(state, origin);
    const muzzle = Cesium.Cartesian3.add(
      origin,
      Cesium.Cartesian3.multiplyByScalar(direction, 16, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const speed = Math.min(state.speed + MISSILE_INITIAL_BOOST, MISSILE_MAX_SPEED);
    const velocity = Cesium.Cartesian3.multiplyByScalar(direction, speed, new Cesium.Cartesian3());
    const id = `${Date.now().toString(36)}-${++this.missileSequence}`;
    const entity = this.world.viewer.entities.add({
      position: muzzle,
      orientation: orientationAlongDirection(direction),
      cylinder: {
        length: 4.5,
        topRadius: 0.08,
        bottomRadius: 0.22,
        material: Cesium.Color.fromCssColorString("#d9e1e8"),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#35424c"),
      },
      polyline: {
        positions: [muzzle, muzzle],
        width: 3,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.fromCssColorString("#ff6b35").withAlpha(0.85),
          glowPower: 0.18,
        }),
      },
    });
    this.missiles.push({
      id,
      targetId: this.lockTargetId,
      position: Cesium.Cartesian3.clone(muzzle),
      velocity,
      speed,
      life: MISSILE_LIFETIME,
      distance: 0,
      decoyed: false,
      decoyPosition: null,
      entity,
    });
    this.missilesRemaining--;
    this.lockTargetId = null;
    this.lockProgress = 0;
    this.lockBeepPlayed = false;
  }

  _releaseFlare(state) {
    const origin = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const direction = this._flightDirection(state, origin);
    const aircraftVelocity = this._aircraftVelocity(state, origin);
    const up = this.world.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
      origin,
      new Cesium.Cartesian3()
    );
    const velocity = Cesium.Cartesian3.add(
      aircraftVelocity,
      Cesium.Cartesian3.multiplyByScalar(direction, -40, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.add(
      velocity,
      Cesium.Cartesian3.multiplyByScalar(up, 8, new Cesium.Cartesian3()),
      velocity
    );
    const position = Cesium.Cartesian3.add(
      origin,
      Cesium.Cartesian3.multiplyByScalar(direction, -8, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const entity = this.world.viewer.entities.add({
      position,
      billboard: {
        image: this.flareSmokeImage,
        width: 44,
        height: 44,
        color: Cesium.Color.WHITE.withAlpha(0.82),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      polyline: {
        positions: [position, position],
        width: 6,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.fromCssColorString("#e52f39").withAlpha(0.42),
          glowPower: 0.32,
        }),
      },
    });
    this.flares.push({
      id: `${Date.now().toString(36)}-${this.flaresRemaining}`,
      position,
      velocity,
      life: FLARE_LIFETIME,
      entity,
    });
    this.flaresRemaining--;
    this.flareCooldown = FLARE_COOLDOWN;
  }

  _advanceMissiles(dt) {
    const targets = new Map((this.fleet ? this.fleet.targets() : []).map((target) => [target.id, target.position]));
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const missile = this.missiles[i];
      missile.life -= dt;
      let targetPosition;

      if (missile.decoyed) {
        const targetState = this.network.players.get(missile.decoyOwner);
        const flare = targetState && (targetState.flares || []).find((item) => item.id === missile.decoyFlareId);
        if (flare) {
          missile.decoyPosition = Cesium.Cartesian3.fromDegrees(flare.lon, flare.lat, flare.alt);
        }
        targetPosition = missile.decoyPosition;
      } else {
        targetPosition = targets.get(missile.targetId);
        const targetState = this.network.players.get(missile.targetId);
        if (targetPosition && targetState) {
          const flare = (targetState.flares || []).find((item) => {
            const flarePosition = Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.alt);
            return Cesium.Cartesian3.distance(flarePosition, targetPosition) < 180 &&
              Cesium.Cartesian3.distance(flarePosition, missile.position) < FLARE_DECOY_RANGE;
          });
          if (flare) {
            missile.decoyed = true;
            missile.decoyOwner = missile.targetId;
            missile.decoyFlareId = flare.id;
            missile.decoyPosition = Cesium.Cartesian3.fromDegrees(flare.lon, flare.lat, flare.alt);
            missile.targetId = null;
            targetPosition = missile.decoyPosition;
          }
        }
      }

      const previousPosition = Cesium.Cartesian3.clone(missile.position);
      if (targetPosition) {
        const desired = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(targetPosition, missile.position, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
        const current = Cesium.Cartesian3.normalize(missile.velocity, new Cesium.Cartesian3());
        const angle = Math.acos(Cesium.Math.clamp(Cesium.Cartesian3.dot(current, desired), -1, 1));
        if (angle > 1e-5) {
          const blend = Math.min(1, MISSILE_MAX_TURN_RATE * dt / angle);
          Cesium.Cartesian3.lerp(current, desired, blend, current);
          Cesium.Cartesian3.normalize(current, current);
        }
        missile.speed = Math.min(MISSILE_MAX_SPEED, missile.speed + MISSILE_ACCELERATION * dt);
        Cesium.Cartesian3.multiplyByScalar(current, missile.speed, missile.velocity);
      }

      const step = Cesium.Cartesian3.multiplyByScalar(missile.velocity, dt, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(missile.position, step, missile.position);
      missile.distance += Cesium.Cartesian3.distance(previousPosition, missile.position);
      missile.entity.position = missile.position;
      missile.entity.orientation = orientationAlongDirection(missile.velocity);
      const trailDirection = Cesium.Cartesian3.normalize(missile.velocity, new Cesium.Cartesian3());
      missile.entity.polyline.positions = [
        Cesium.Cartesian3.subtract(
          missile.position,
          Cesium.Cartesian3.multiplyByScalar(trailDirection, 12, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        ),
        missile.position,
      ];

      let consumed = missile.life <= 0 || missile.distance >= MISSILE_LOCK_RANGE * 1.5 || !targetPosition;
      if (!consumed) {
        const segment = Cesium.Cartesian3.subtract(
          missile.position,
          previousPosition,
          new Cesium.Cartesian3()
        );
        const segmentLengthSquared = Cesium.Cartesian3.magnitudeSquared(segment);
        const toTarget = Cesium.Cartesian3.subtract(
          targetPosition,
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
        if (Cesium.Cartesian3.distance(closestPoint, targetPosition) <= MISSILE_HIT_RADIUS) {
          if (!missile.decoyed) {
            this.network.reportHit(missile.targetId, MISSILE_DAMAGE);
          }
          consumed = true;
        }
      }
      if (consumed) {
        this.world.viewer.entities.remove(missile.entity);
        this.missiles.splice(i, 1);
      }
    }
  }

  _advanceFlares(dt) {
    const gravityStep = new Cesium.Cartesian3();
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const flare = this.flares[i];
      flare.life -= dt;
      const up = this.world.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
        flare.position,
        new Cesium.Cartesian3()
      );
      const gravity = Cesium.Cartesian3.multiplyByScalar(up, -BULLET_GRAVITY, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(
        flare.velocity,
        Cesium.Cartesian3.multiplyByScalar(gravity, dt, gravityStep),
        flare.velocity
      );
      const step = Cesium.Cartesian3.multiplyByScalar(flare.velocity, dt, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(flare.position, step, flare.position);
      flare.entity.position = flare.position;
      const progress = 1 - flare.life / FLARE_LIFETIME;
      flare.entity.billboard.scale = 0.7 + progress * 1.8;
      flare.entity.billboard.color = Cesium.Color.WHITE.withAlpha(0.82 * (1 - progress * 0.65));
      const direction = Cesium.Cartesian3.normalize(flare.velocity, new Cesium.Cartesian3());
      flare.entity.polyline.positions = [
        Cesium.Cartesian3.subtract(
          flare.position,
          Cesium.Cartesian3.multiplyByScalar(direction, 24, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        ),
        flare.position,
      ];

      if (flare.life <= 0) {
        this.world.viewer.entities.remove(flare.entity);
        this.flares.splice(i, 1);
      }
    }
  }

  _fire(state) {
    const origin = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, state.height);
    const direction = this._gunAimDirection(state, origin);
    const aircraftVelocity = this._aircraftVelocity(state, origin);
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

    const tracer = this.rounds % TRACER_INTERVAL === 0;
    const bullet = {
      id: `${Date.now().toString(36)}-${this.rounds}`,
      position: Cesium.Cartesian3.clone(muzzle),
      velocity,
      distance: 0,
      life: BULLET_LIFETIME,
      tracer,
      entity: this.world.viewer.entities.add({
        position: muzzle,
        point: {
          pixelSize: 4,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#ffb53d"),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        polyline: {
          positions: [muzzle, muzzle],
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: Cesium.Color.fromCssColorString("#ffd98a").withAlpha(0.9),
            glowPower: 0.22,
          }),
          show: true,
        },
      }),
    };
    this.bullets.push(bullet);
    this.rounds++;
  }

  _gunAimDirection(state, origin) {
    return this._flightDirection(state, origin);
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
      bullet.entity.orientation = orientationAlongDirection(bullet.velocity);
      const trailDirection = Cesium.Cartesian3.normalize(bullet.velocity, new Cesium.Cartesian3());
      const trailStart = Cesium.Cartesian3.subtract(
        bullet.position,
        Cesium.Cartesian3.multiplyByScalar(trailDirection, TRACER_LENGTH, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      bullet.entity.polyline.positions = [trailStart, bullet.position];

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
    for (const missile of this.missiles) this.world.viewer.entities.remove(missile.entity);
    this.missiles = [];
    for (const flare of this.flares) this.world.viewer.entities.remove(flare.entity);
    this.flares = [];
    this.lockTargetId = null;
    this.lockProgress = 0;
    this.lockBeepPlayed = false;
    this.cancelPendingActions();
  }
}

// ---------------------------------------------------------------------------
// MiniMap — a small Cesium globe with FFA radar markers
// ---------------------------------------------------------------------------

class MiniMap {
  constructor() {
    this.labelEl = document.getElementById("miniMapLabel");
    this.enemyCountEl = document.getElementById("miniMapEnemyCount");
    this.enemies = new Map();
    this.lastUpdate = 0;
    this.viewer = new Cesium.Viewer("miniMapGlobe", {
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      })),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
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
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    });
    this.viewer.resolutionScale = 0.75;
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.globe.maximumScreenSpaceError = 2;
    this.viewer.scene.skyAtmosphere.show = true;
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    this.viewer.camera.frustum.fov = Cesium.Math.toRadians(48);
    this.ownMarker = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      billboard: {
        image: this._createArrowImage("#2878ff"),
        width: 20,
        height: 28,
        rotation: 0,
        heightReference: Cesium.HeightReference.NONE,
      },
    });
  }

  _createArrowImage(color) {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a minimap aircraft marker.");
    context.beginPath();
    context.moveTo(24, 3);
    context.lineTo(43, 44);
    context.lineTo(24, 35);
    context.lineTo(5, 44);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "#ffffff";
    context.stroke();
    return canvas.toDataURL("image/png");
  }

  show() {
    document.getElementById("miniMapWrap").classList.remove("hidden");
    this.viewer.resize();
    this.viewer.scene.requestRender();
  }

  hide() {
    document.getElementById("miniMapWrap").classList.add("hidden");
  }

  update(state, players) {
    const now = performance.now();
    if (now - this.lastUpdate < 100) return;
    this.lastUpdate = now;

    const surface = Cesium.Cartesian3.fromDegrees(state.longitude, state.latitude, 0);
    const up = this.viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
      surface,
      new Cesium.Cartesian3()
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(surface);
    const north = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      Cesium.Cartesian3.UNIT_Y,
      new Cesium.Cartesian3()
    );
    const cameraPosition = Cesium.Cartesian3.add(
      surface,
      Cesium.Cartesian3.multiplyByScalar(up, 12000000, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const direction = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3());
    this.viewer.camera.setView({
      destination: cameraPosition,
      orientation: { direction, up: north },
    });

    this.ownMarker.position = Cesium.Cartesian3.fromDegrees(
      state.longitude,
      state.latitude,
      Math.max(0, state.height)
    );
    this.ownMarker.billboard.rotation = -state.heading;

    const seen = new Set();
    for (const [id, player] of players) {
      if (!Number.isFinite(player.lon) || !Number.isFinite(player.lat) ||
          player.alive === false) continue;
      seen.add(id);
      let marker = this.enemies.get(id);
      if (!marker) {
        marker = this.viewer.entities.add({
          billboard: {
            image: this._createArrowImage("#f04452"),
            width: 18,
            height: 25,
            rotation: 0,
            heightReference: Cesium.HeightReference.NONE,
          },
        });
        this.enemies.set(id, marker);
      }
      marker.position = Cesium.Cartesian3.fromDegrees(
        player.lon,
        player.lat,
        Math.max(0, player.alt || 0)
      );
      marker.billboard.rotation = -(Number.isFinite(player.hdg) ? player.hdg : 0);
    }

    for (const [id, marker] of this.enemies) {
      if (seen.has(id)) continue;
      this.viewer.entities.remove(marker);
      this.enemies.delete(id);
    }

    if (this.labelEl) {
      const latDirection = state.latitude < 0 ? "S" : "N";
      const lonDirection = state.longitude < 0 ? "W" : "E";
      this.labelEl.textContent =
        `${Math.abs(state.latitude).toFixed(3)}°${latDirection} ${Math.abs(state.longitude).toFixed(3)}°${lonDirection}`;
    }
    if (this.enemyCountEl) {
      this.enemyCountEl.textContent = `ENEMIES ${this.enemies.size}`;
    }
    this.viewer.scene.requestRender();
  }
}

// ---------------------------------------------------------------------------
// HUD — DOM readout of a PlayerState
// ---------------------------------------------------------------------------

class HUD {
  constructor() {
    this.el = document.getElementById("flightHud");
    this.combatPanelEl = document.getElementById("combatHudPanel");
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

  hide() {
    this.el.classList.add("hidden");
  }

  setMode(mode) {
    this.combatPanelEl.classList.toggle("hidden", mode !== "multiplayer");
  }

  update(state) {
    this.altEl.textContent = `${Math.round(state.height)} m`;
    this.speedEl.textContent = `${Math.min(10, state.speed / 343).toFixed(1)}`;
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
  constructor(settings, onMenuStateChange, canOpen, onFieldOfViewChange, onLeave) {
    this.settings = settings;
    this.onMenuStateChange = onMenuStateChange;
    this.canOpen = canOpen;
    this.onFieldOfViewChange = onFieldOfViewChange;
    this.onLeave = onLeave;
    this.el = document.getElementById("settingsMenu");
    this.steeringInput = document.getElementById("steeringSensitivity");
    this.cameraInput = document.getElementById("cameraSensitivity");
    this.fieldOfViewInput = document.getElementById("fieldOfView");
    this.steeringValue = document.getElementById("steeringSensitivityValue");
    this.cameraValue = document.getElementById("cameraSensitivityValue");
    this.fieldOfViewValue = document.getElementById("fieldOfViewValue");
    this.isOpen = false;

    this.steeringInput.value = settings.steeringSensitivity;
    this.cameraInput.value = settings.cameraSensitivity;
    this.fieldOfViewInput.value = settings.fieldOfView;
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
    this.fieldOfViewInput.addEventListener("input", () => {
      settings.fieldOfView = Number(this.fieldOfViewInput.value);
      this._updateLabels();
      settings.save();
      this.onFieldOfViewChange();
    });
    document.getElementById("resumeFlightBtn").addEventListener("click", () => this.close());
    document.getElementById("leaveFlightBtn").addEventListener("click", () => {
      this.close(false);
      this.onLeave();
    });
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
    this.fieldOfViewValue.value = `${Number(this.fieldOfViewInput.value)}°`;
  }

  open() {
    this.isOpen = true;
    this.el.classList.remove("hidden");
    this.onMenuStateChange();
    this.steeringInput.focus();
  }

  close(relockPointer = true) {
    this.isOpen = false;
    this.el.classList.add("hidden");
    this.onMenuStateChange(relockPointer);
  }
}

class FullscreenToggle {
  constructor() {
    this.button = document.getElementById("fullscreenToggle");
    this.errorMessage = false;
    if (typeof document.documentElement.requestFullscreen !== "function" ||
        document.fullscreenEnabled === false) {
      this.button.disabled = true;
      this.button.title = "Fullscreen is not available in this browser.";
      return;
    }

    this.button.addEventListener("click", async () => {
      this.button.disabled = true;
      this.errorMessage = false;
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) {
        console.error("Could not change fullscreen mode.", error);
        this.errorMessage = true;
      } finally {
        this.button.disabled = false;
        this.update();
      }
    });
    document.addEventListener("fullscreenchange", () => this.update());
    this.update();
  }

  update() {
    const isFullscreen = Boolean(document.fullscreenElement);
    this.button.textContent = this.errorMessage
      ? "RETRY FULL SCREEN"
      : isFullscreen ? "EXIT FULL SCREEN" : "FULL SCREEN";
    this.button.setAttribute("aria-pressed", String(isFullscreen));
    this.button.title = this.errorMessage
      ? "Fullscreen could not be changed. Select to try again."
      : isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
  }
}

// ---------------------------------------------------------------------------
// StartScreenUI — wires the start-screen DOM to the SpawnSelector
// ---------------------------------------------------------------------------

class StartScreenUI {
  constructor(countryBoundaries, onStartFlight, onModeSelected, onCountrySelected, onBackToModes) {
    this.countryBoundaries = countryBoundaries;
    this.onStartFlight = onStartFlight;
    this.onModeSelected = onModeSelected;
    this.onCountrySelected = onCountrySelected;
    this.onBackToModes = onBackToModes;
    this.modeEl = document.getElementById("modeSelection");
    this.spawnSetupEl = document.getElementById("spawnSetup");
    this.selectionBox = document.getElementById("selectionBox");
    this.selectionCoords = document.getElementById("selectionCoords");
    this.startBtn = document.getElementById("startFlightBtn");
    this.countryWrap = document.getElementById("countrySelectWrap");
    this.countrySelect = document.getElementById("countrySelect");
    this.countryStatusEl = document.getElementById("countryLobbyStatus");
    this.modeMessageEl = document.getElementById("modeMessage");
    this.spawnMessageEl = document.getElementById("spawnMessage");
    this.spawnHeadlineEl = document.getElementById("spawnHeadline");
    this.spawnDescriptionEl = document.getElementById("spawnDescription");
    this.modeButtons = [
      document.getElementById("singlePlayerModeBtn"),
      document.getElementById("multiplayerModeBtn"),
    ];
    this.selectedMode = null;
    this.selectedCountry = null;
    this.creditsToggle = document.getElementById("creditsToggle");
    this.creditsPanel = document.getElementById("creditsPanel");

    this.startBtn.addEventListener("click", () => {
      if (this.startBtn.disabled) return;
      this.onStartFlight(this.selectedMode, this.selectedCountry);
    });
    this.modeButtons[0].addEventListener("click", () => this.onModeSelected("explore"));
    this.modeButtons[1].addEventListener("click", () => this.onModeSelected("multiplayer"));
    this.countrySelect.addEventListener("change", () => {
      this.selectedCountry = this.countryBoundaries.byName.get(this.countrySelect.value) || null;
      this.clearSpawnSelection();
      this.onCountrySelected(this.selectedCountry);
    });
    document.getElementById("backToModesBtn").addEventListener("click", () => this.onBackToModes());

    this.creditsToggle.addEventListener("click", () => {
      this.creditsPanel.classList.toggle("hidden");
    });
  }

  showModeSelection() {
    this.selectedMode = null;
    this.selectedCountry = null;
    this.modeEl.classList.remove("hidden");
    this.spawnSetupEl.classList.add("hidden");
    this.modeMessageEl.textContent = "";
    this.countryStatusEl.textContent = "";
    this.startBtn.disabled = true;
  }

  showModeError(message) {
    this.modeMessageEl.textContent = message;
  }

  enterMode(mode, countries) {
    this.selectedMode = mode;
    this.modeEl.classList.add("hidden");
    this.spawnSetupEl.classList.remove("hidden");
    this.spawnMessageEl.textContent = "";
    this.clearSpawnSelection();
    this.countryWrap.classList.toggle("hidden", mode !== "multiplayer");
    this.countryStatusEl.classList.toggle("hidden", mode !== "multiplayer");
    if (mode === "multiplayer") {
      this.spawnHeadlineEl.innerHTML = "CHOOSE A COUNTRY<br />AND SPAWN POINT";
      this.spawnDescriptionEl.textContent = "Choose a country, then click inside its borders to join that country's fight.";
      this.countrySelect.replaceChildren(new Option("Choose a country", ""));
      for (const country of countries) {
        this.countrySelect.add(new Option(country.properties.name, country.properties.name));
      }
      this.selectedCountry = null;
      this.countryStatusEl.textContent = "Choose any country to see its lobby.";
    } else {
      this.spawnHeadlineEl.innerHTML = "EXPLORE THE<br />GLOBE";
      this.spawnDescriptionEl.textContent = "Click anywhere on the globe to begin a peaceful single-player flight.";
      this.selectedCountry = null;
    }
    this.updateStartButton();
  }

  onSpawnSelected(longitude, latitude) {
    this.selectionBox.classList.remove("selection-box--empty");
    this.selectionBox.classList.add("selection-box--filled");
    this.selectionCoords.textContent = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    this.spawnMessageEl.textContent = "";
    this.updateStartButton();
  }

  onSpawnRejected(message) {
    this.spawnMessageEl.textContent = message;
  }

  clearSpawnSelection() {
    this.selectionBox.classList.remove("selection-box--filled");
    this.selectionBox.classList.add("selection-box--empty");
    this.selectionCoords.textContent = "Click the globe";
    this.updateStartButton();
  }

  updateStartButton() {
    this.startBtn.disabled = this.selectedMode === null ||
      (this.selectedMode === "multiplayer" && !this.selectedCountry) ||
      this.selectionBox.classList.contains("selection-box--empty");
  }

  updateCountryStatus(country, onlineCount) {
    if (country !== this.selectedCountry?.properties.name) return;
    this.countryStatusEl.textContent = onlineCount > 0
      ? `${onlineCount} other pilot${onlineCount === 1 ? "" : "s"} online in this country.`
      : "No other pilots online yet; this country lobby stays open.";
  }

  setCountryConnectionStatus(country, message) {
    if (country === this.selectedCountry?.properties.name) {
      this.countryStatusEl.textContent = message;
    }
  }

  clearCountryStatus() {
    this.countryStatusEl.textContent = "Choose any country to see its lobby.";
  }

  hide() {
    document.getElementById("startScreen").classList.add("hidden");
  }

  show() {
    document.getElementById("startScreen").classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// Main — wires everything together
// ---------------------------------------------------------------------------

async function main() {
  new FullscreenToggle();
  const world = new CesiumWorld("cesiumContainer");
  const damageSmoke = new DamageSmoke(world);
  const explosion = new AircraftExplosion(world);
  const hud = new HUD();
  const settings = new FlightSettings();
  const chaseCamera = new ChaseCamera(world, settings);
  const miniMap = new MiniMap();

  const network = new NetworkClient(MULTIPLAYER_URL);
  const globeMarkers = new GlobeMarkers(world);
  const fleet = new RemoteFleet(world, network);
  const guns = new Guns(world, network, fleet);
  const countryBoundaries = new CountryBoundaries();

  let flightController = null;
  let aircraft = null;
  let gameMode = null;
  let selectedCountry = null;
  let spawnSelector = null;
  let flying = false;
  let health = MAX_HEALTH;
  let alive = true;
  let deathTimer = 0;
  const deathScreenEl = document.getElementById("deathScreen");
  const deathReasonEl = document.getElementById("deathReason");
  const deathCountdownEl = document.getElementById("deathCountdown");
  const settingsMenu = new FlightSettingsMenu(
    settings,
    (relockPointer = true) => {
      if (flightController) flightController.keys.clear();
      guns.cancelPendingActions();
      if (settingsMenu.isOpen) chaseCamera.unlockPointer();
      else if (relockPointer && flying) chaseCamera.lockPointer();
    },
    () => flying,
    () => chaseCamera.applyFieldOfView(),
    () => leaveFlight()
  );

  network.onStatus = (status) => {
    hud.setNetStatus(status);
    if (selectedCountry && status !== "ONLINE") {
      startScreenUI.setCountryConnectionStatus(
        selectedCountry.properties.name,
        status === "OFFLINE"
          ? "Multiplayer relay is not configured."
          : "Connecting to the multiplayer relay..."
      );
    }
  };
  // Red dots on the start-screen globe show where everyone already is, so you
  // can choose to spawn into the fight or well away from it.
  network.onRoster = (players) => globeMarkers.update(players);
  network.onHit = (msg) => {
    if (!alive || gameMode !== "multiplayer") return;
    health -= msg.damage ?? BULLET_DAMAGE;
    hud.banner("HIT", 600);
    if (health <= 0) beginDeathSequence("SHOT DOWN");
  };
  network.onRoomStatus = ({ country, count }) => {
    if (country) startScreenUI.updateCountryStatus(country, Math.max(0, count - 1));
  };

  window.addEventListener("keydown", (event) => {
    if (
      event.code !== "KeyV" ||
      event.repeat ||
      !flying ||
      !alive ||
      !document.getElementById("settingsMenu").classList.contains("hidden")
    ) return;
    chaseCamera.firstPerson = !chaseCamera.firstPerson;
    aircraft.setFirstPerson(chaseCamera.firstPerson);
    chaseCamera.reset();
  });

  // Nose-alignment debug keys. Should not be needed with the shipped model.
  window.addEventListener("keydown", (e) => {
    if (!aircraft) return;
    if (e.code === "BracketLeft") aircraft.setNoseYaw(MODEL_NOSE_YAW_DEGREES - 15);
    if (e.code === "BracketRight") aircraft.setNoseYaw(MODEL_NOSE_YAW_DEGREES + 15);
    if (e.code === "BracketLeft" || e.code === "BracketRight") hud.setNoseYaw(MODEL_NOSE_YAW_DEGREES);
  });

  function beginDeathSequence(reason) {
    if (!flying || !alive || !flightController) return;
    alive = false;
    chaseCamera.unlockPointer();
    health = 0;
    deathTimer = DEATH_SCREEN_DURATION;
    flightController.keys.clear();
    guns.cancelPendingActions();
    guns.clear();
    damageSmoke.clear();
    explosion.start(flightController.state);
    if (aircraft) {
      chaseCamera.firstPerson = false;
      aircraft.setFirstPerson(false);
      chaseCamera.follow(flightController.state, 1 / 60);
    }
    if (gameMode === "multiplayer") {
      network.sendState(
        flightController.state,
        health,
        false,
        guns.getNetworkOrdnance(),
        true
      );
      hud.updateCombat(health, network.players.size + 1);
    }
    deathReasonEl.textContent = reason;
    deathCountdownEl.textContent = `${Math.ceil(deathTimer)}`;
    deathScreenEl.classList.remove("hidden");
  }

  const startScreenUI = new StartScreenUI(
    countryBoundaries,
    async (mode, country) => {
    const { longitude, latitude } = spawnSelector.selectedLonLat;
      await beginFlight(longitude, latitude, mode, country);
    },
    async (mode) => {
      network.leaveCountry();
      selectedCountry = null;
      try {
        const countries = mode === "multiplayer" ? await countryBoundaries.load() : [];
        startScreenUI.enterMode(mode, countries);
      } catch (error) {
        console.error("Could not load country boundaries.", error);
        startScreenUI.showModeError("Country data could not be loaded. Please try again.");
      }
    },
    (country) => {
      selectedCountry = country;
      if (country) {
        network.joinCountry(country.properties.name);
        startScreenUI.setCountryConnectionStatus(
          country.properties.name,
          network.connected
            ? "Joining this country's lobby..."
            : network.url
              ? "Connecting to the multiplayer relay..."
              : "Multiplayer relay is not configured."
        );
      } else {
        network.leaveCountry();
        startScreenUI.clearCountryStatus();
      }
    },
    () => {
      network.leaveCountry();
      selectedCountry = null;
      gameMode = null;
      spawnSelector.clearSelection();
      startScreenUI.showModeSelection();
      world.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(0, 20, 22000000),
        duration: 1,
      });
    }
  );
  spawnSelector = new SpawnSelector(world, startScreenUI);
  network.connect();

  function leaveFlight() {
    if (!flying) return;
    guns.clear();
    damageSmoke.clear();
    explosion.clear();
    deathScreenEl.classList.add("hidden");
    if (flightController) {
      if (gameMode === "multiplayer") {
        network.sendState(
          flightController.state,
          health,
          false,
          guns.getNetworkOrdnance(),
          true
        );
      }
    }
    network.leaveCountry();
    flying = false;
    alive = false;
    gameMode = null;
    selectedCountry = null;
    chaseCamera.unlockPointer();
    if (flightController) flightController.keys.clear();
    guns.resetLoadout();
    fleet.clear();
    if (aircraft) aircraft.destroy();
    aircraft = null;
    flightController = null;
    chaseCamera.enabled = false;
    chaseCamera.reset();
    world.viewer.scene.screenSpaceCameraController.enableInputs = true;
    hud.hide();
    hud.clearBanner();
    miniMap.hide();
    globeMarkers.setVisible(true);
    spawnSelector.clearSelection();
    startScreenUI.showModeSelection();
    startScreenUI.show();
    world.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(0, 20, 22000000),
      duration: 1,
    });
  }

  async function beginFlight(longitude, latitude, mode, country) {
    gameMode = mode;
    selectedCountry = country;
    if (gameMode === "multiplayer" && selectedCountry) {
      network.joinCountry(selectedCountry.properties.name);
    } else {
      network.leaveCountry();
    }
    chaseCamera.lockPointer();
    startScreenUI.hide();
    spawnSelector.clearMarker();
    damageSmoke.clear();
    explosion.clear();
    deathScreenEl.classList.add("hidden");

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
    chaseCamera.firstPerson = true;
    aircraft.setFirstPerson(true);
    flightController = new FlightController(spawnState, settings);
    guns.clear();
    guns.resetLoadout();
    chaseCamera.reset();
    chaseCamera.enabled = true;
    world.viewer.scene.screenSpaceCameraController.enableInputs = false;
    hud.show();
    hud.setMode(gameMode);
    hud.setNoseYaw(MODEL_NOSE_YAW_DEGREES);
    if (gameMode === "multiplayer") miniMap.show();
    // The start-screen dots would otherwise sit inside the other aircraft now
    // that they're drawn as real models.
    globeMarkers.setVisible(gameMode !== "multiplayer");
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

    if (!alive) {
      flightController.keys.clear();
      explosion.update(dt);
      deathTimer = Math.max(0, deathTimer - dt);
      deathCountdownEl.textContent = `${Math.ceil(deathTimer)}`;
      if (deathTimer <= 0) leaveFlight();
      return;
    }

    const previousFlightPosition = {
      longitude: flightController.state.longitude,
      latitude: flightController.state.latitude,
    };
    flightController.update(dt);

    if (flightController.justReset) chaseCamera.reset();
    if (gameMode === "multiplayer" && selectedCountry) {
      countryBoundaries.clampSegment(
        selectedCountry,
        previousFlightPosition,
        flightController.state
      );
    }

    // Ground-collision clamp: keep the aircraft from passing through
    // terrain. Done here (not inside FlightController.update) since it
    // needs a globe height lookup — see clampToTerrain()'s doc comment.
    const groundHeight = world.getHeightSync(
      flightController.state.longitude,
      flightController.state.latitude
    );
    const groundImpact = flightController.clampToTerrain(groundHeight);

    const state = flightController.state;
    if (groundImpact) {
      aircraft.render(state);
      chaseCamera.follow(state, dt);
      beginDeathSequence("GROUND IMPACT");
      explosion.update(dt);
      return;
    }

    aircraft.render(state);
    damageSmoke.update(dt, state, alive && health <= LOW_HEALTH_SMOKE_THRESHOLD);
    chaseCamera.follow(state, dt);
    hud.update(state);

    guns.update(dt, state, alive && gameMode === "multiplayer");
    if (gameMode === "multiplayer") {
      fleet.update();
      network.sendState(state, health, alive, guns.getNetworkOrdnance());
      hud.updateCombat(health, network.players.size + 1);
      miniMap.update(state, network.players);
    }
  });
}

main();
