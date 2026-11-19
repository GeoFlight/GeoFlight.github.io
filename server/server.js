// ---------------------------------------------------------------------------
// GeoFlight multiplayer relay
// ---------------------------------------------------------------------------
// A thin fan-out server: it holds no game rules and runs no physics. Clients
// send their own position, the server forwards it to everyone else. Hits are
// decided by the shooting client and relayed to the victim.
//
// That means a modified client can cheat (teleport, fire without cooldown,
// claim hits it never made). That is a deliberate trade for a simple alpha —
// when it starts mattering, move hit validation into this file, where the
// server already sees every player's last known position.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const HEARTBEAT_MS = 30000;   // Render closes idle sockets; ping keeps them warm
const ROSTER_MS = 1000;       // full roster broadcast rate (for start-screen dots)

const players = new Map(); // ws -> { id, country, lon, lat, alt, hdg, pit, rol, spd, hp, alive }

// Render's health checks hit plain HTTP, so the WS server rides on an HTTP one.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", players: players.size }));
});

const wss = new WebSocketServer({ server });

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function playersInCountry(country) {
  return [...players.entries()].filter(([, player]) => player.country === country);
}

function broadcastToCountry(country, obj, exclude) {
  if (!country) return;
  const payload = JSON.stringify(obj);
  for (const [ws, player] of players) {
    if (player.country === country && ws !== exclude && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function sendCountryStatus(country) {
  if (!country) return;
  const room = playersInCountry(country);
  for (const [ws] of room) {
    send(ws, { type: "room-status", country, count: room.length });
  }
}

wss.on("connection", (ws) => {
  const id = makeId();
  players.set(ws, { id, country: null, alive: false, hp: 100 });
  ws.isAlive = true;

  send(ws, { type: "welcome", id });

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // ignore anything that isn't JSON
    }

    const player = players.get(ws);
    if (!player) return;

    if (msg.type === "join-country") {
      const country = typeof msg.country === "string" ? msg.country.trim().slice(0, 80) : "";
      if (!country) return;
      const previousCountry = player.country;
      if (previousCountry && previousCountry !== country) {
        broadcastToCountry(previousCountry, { type: "leave", id: player.id }, ws);
        player.country = null;
        player.lon = undefined;
        player.lat = undefined;
        player.alive = false;
        sendCountryStatus(previousCountry);
      }
      player.country = country;
      const roster = playersInCountry(country)
        .filter(([otherWs, other]) => otherWs !== ws && other.lon !== undefined)
        .map(([, other]) => ({
          id: other.id,
          lon: other.lon,
          lat: other.lat,
          alt: other.alt,
          hdg: other.hdg,
          pit: other.pit,
          rol: other.rol,
          spd: other.spd,
          hp: other.hp,
          alive: other.alive,
        }));
      send(ws, { type: "roster", players: roster });
      sendCountryStatus(country);
      return;
    }

    if (msg.type === "leave-country") {
      const previousCountry = player.country;
      player.country = null;
      player.lon = undefined;
      player.lat = undefined;
      player.alive = false;
      if (previousCountry) {
        broadcastToCountry(previousCountry, { type: "leave", id: player.id }, ws);
        sendCountryStatus(previousCountry);
      }
      return;
    }

    if (msg.type === "state") {
      if (!player.country) return;
      Object.assign(player, {
        lon: msg.lon,
        lat: msg.lat,
        alt: msg.alt,
        hdg: msg.hdg,
        pit: msg.pit,
        rol: msg.rol,
        spd: msg.spd,
        hp: msg.hp,
        alive: msg.alive,
      });
      // Position updates go out immediately rather than waiting for the next
      // roster tick, otherwise dogfighting feels laggy.
      broadcastToCountry(
        player.country,
        { ...msg, type: "state", id: player.id, country: player.country },
        ws
      );
      return;
    }

    if (msg.type === "hit") {
      if (!player.country) return;
      for (const [targetWs, target] of players) {
        if (target.country === player.country && target.id === msg.target) {
          send(targetWs, {
            type: "hit",
            target: msg.target,
            by: player.id,
            damage: Math.min(Number(msg.damage) || 0, 50), // cap absurd claims
          });
          break;
        }
      }
    }
  });

  ws.on("close", () => {
    const player = players.get(ws);
    players.delete(ws);
    if (player && player.country) {
      broadcastToCountry(player.country, { type: "leave", id: player.id });
      sendCountryStatus(player.country);
    }
  });
});

// Full roster on a slow tick. The flight loop runs off the faster 'state'
// messages; this exists so the start screen can show red dots for everyone
// before you've spawned, and so a client that missed an update recovers.
setInterval(() => {
  for (const [ws, player] of players) {
    if (!player.country || ws.readyState !== ws.OPEN) continue;
    const roster = playersInCountry(player.country)
      .filter(([otherWs, other]) => otherWs !== ws && other.lon !== undefined)
      .map(([, other]) => ({
        id: other.id,
        lon: other.lon,
        lat: other.lat,
        alt: other.alt,
        hdg: other.hdg,
        pit: other.pit,
        rol: other.rol,
        spd: other.spd,
        hp: other.hp,
        alive: other.alive,
      }));
    send(ws, { type: "roster", players: roster });
  }
}, ROSTER_MS);

// Drop sockets that stopped answering instead of leaving ghost planes in the
// air for everyone else.
setInterval(() => {
  for (const [ws] of players) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`GeoFlight relay listening on ${PORT}`);
});
