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

const players = new Map(); // ws -> { id, lon, lat, alt, hdg, pit, rol, spd, hp, alive }

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

function broadcast(obj, exclude) {
  const payload = JSON.stringify(obj);
  for (const [ws] of players) {
    if (ws !== exclude && ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on("connection", (ws) => {
  const id = makeId();
  players.set(ws, { id, alive: true, hp: 100 });
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

    if (msg.type === "state") {
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
      broadcast({ type: "state", id: player.id, ...msg }, ws);
      return;
    }

    if (msg.type === "hit") {
      for (const [targetWs, target] of players) {
        if (target.id === msg.target) {
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
    if (player) broadcast({ type: "leave", id: player.id });
  });
});

// Full roster on a slow tick. The flight loop runs off the faster 'state'
// messages; this exists so the start screen can show red dots for everyone
// before you've spawned, and so a client that missed an update recovers.
setInterval(() => {
  const roster = [...players.values()]
    .filter((p) => p.lon !== undefined)
    .map(({ id, lon, lat, alt, hdg, pit, rol, spd, hp, alive }) => ({
      id, lon, lat, alt, hdg, pit, rol, spd, hp, alive,
    }));
  broadcast({ type: "roster", players: roster });
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
