const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── HTTP server (serves index.html) ────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Strip query string before matching e.g. /?join=123456 → /
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── Session store ───────────────────────────────────────────────────────────
// sessions[code] = { laptop: ws | null, mobile: ws | null }
const sessions = {};

function generateCode() {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); }
  while (sessions[code]);
  return code;
}

function cleanupSocket(ws) {
  for (const [code, session] of Object.entries(sessions)) {
    const role = session.laptop === ws ? 'laptop' : session.mobile === ws ? 'mobile' : null;
    if (!role) continue;

    session[role] = null;
    const peer = role === 'laptop' ? session.mobile : session.laptop;

    if (peer) {
      safeSend(peer, { type: 'peer-disconnected', role });
    }

    // If both gone, delete session after short delay
    if (!session.laptop && !session.mobile) {
      setTimeout(() => { if (!sessions[code]?.laptop && !sessions[code]?.mobile) delete sessions[code]; }, 5000);
    }
    break;
  }
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Laptop creates a session ──────────────────────────────────────────
      case 'create-session': {
        const code = generateCode();
        sessions[code] = { laptop: ws, mobile: null };
        ws._code = code;
        safeSend(ws, { type: 'session-created', code });
        break;
      }

      // ── Mobile joins a session ────────────────────────────────────────────
      case 'join-session': {
        const { code } = msg;
        const session = sessions[code];
        if (!session) { safeSend(ws, { type: 'error', message: 'Session not found. Check the code and try again.' }); return; }
        if (session.mobile) { safeSend(ws, { type: 'error', message: 'Session already has a mobile device connected.' }); return; }
        if (!session.laptop) { safeSend(ws, { type: 'error', message: 'Laptop disconnected. Ask them to create a new session.' }); return; }

        session.mobile = ws;
        ws._code = code;
        safeSend(ws, { type: 'session-joined', code });
        safeSend(session.laptop, { type: 'peer-joined' }); // tell laptop to initiate
        break;
      }

      // ── WebRTC signaling relay ────────────────────────────────────────────
      // Both sides send offer/answer/ice-candidate, server just forwards to other peer
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const session = sessions[ws._code];
        if (!session) return;
        const peer = session.laptop === ws ? session.mobile : session.laptop;
        if (peer) safeSend(peer, msg);
        break;
      }

      // ── Heartbeat ─────────────────────────────────────────────────────────
      case 'ping':
        safeSend(ws, { type: 'pong' });
        break;
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🎥  PhoneCam server running → http://localhost:${PORT}\n`);
});