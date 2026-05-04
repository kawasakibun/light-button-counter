const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const sseClients = new Set();

// ===== ゲーム状態 =====
const MIN_SEC = 10;
const MAX_SEC = 600;

function clampSec(v) {
  let n = parseInt(v);
  if (!Number.isFinite(n)) n = 60;
  // 10秒刻みに丸める
  n = Math.round(n / 10) * 10;
  return Math.max(MIN_SEC, Math.min(MAX_SEC, n));
}

let game = {
  status: 'idle',           // 'idle' | 'running' | 'ended'
  durationSec: 60,
  durationMs: 60_000,
  startedAt: 0,
  endsAt: 0,
  buttonCount: 0,
  lightCount: 0,
};
let timerHandle = null;

// 光検出ヒストグラムは「現在の制限時間」に紐づく。設定が変わったらリセット。
let histogramDurationSec = null;
let histogramCounts = []; // 各ゲーム終了時に game.lightCount を push

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== ESP からのイベント (light / button) =====
app.post('/api/event', (req, res) => {
  const type = req.body && req.body.type;
  if (game.status !== 'running') {
    return res.json({ ok: true, ignored: true, reason: 'no-game' });
  }
  if (type === 'button') {
    game.buttonCount++;
  } else if (type === 'light') {
    game.lightCount++;
  } else {
    return res.status(400).json({ ok: false, error: 'unknown type' });
  }
  console.log(`[event] ${type}  button=${game.buttonCount} light=${game.lightCount}`);
  broadcastState();
  res.json({ ok: true });
});

// 後方互換: 旧 /api/count は button イベントとして扱う
app.post('/api/count', (req, res) => {
  if (game.status === 'running') {
    game.buttonCount++;
    broadcastState();
  }
  res.json({ ok: true });
});

// ===== ゲーム開始 =====
app.post('/api/game/start', (req, res) => {
  // 旧クライアント互換: durationMin が来たら秒に変換
  let sec;
  if (req.body?.durationSec != null) {
    sec = clampSec(req.body.durationSec);
  } else if (req.body?.durationMin != null) {
    sec = clampSec(parseInt(req.body.durationMin) * 60);
  } else {
    sec = 60;
  }

  // 制限時間が変わったらヒストグラムをリセット
  if (histogramDurationSec !== sec) {
    histogramCounts = [];
    histogramDurationSec = sec;
  }

  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }

  const now = Date.now();
  const ms = sec * 1000;
  game = {
    status: 'running',
    durationSec: sec,
    durationMs: ms,
    startedAt: now,
    endsAt: now + ms,
    buttonCount: 0,
    lightCount: 0,
  };

  timerHandle = setTimeout(endGame, ms);
  console.log(`[game] start duration=${sec}s`);
  broadcastState();
  res.json({ ok: true, state: snapshotState() });
});

// ===== ゲーム終了 =====
function endGame() {
  if (game.status !== 'running') return;
  game.status = 'ended';
  game.endsAt = Date.now();
  if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }

  // ヒストグラムへ light count を蓄積
  histogramCounts.push(game.lightCount);

  console.log(`[game] end score=${game.buttonCount} light=${game.lightCount}`);
  broadcastState();
}

// 手動終了
app.post('/api/game/end', (req, res) => {
  endGame();
  res.json({ ok: true, state: snapshotState() });
});

// 手動リセット (現在の制限時間の光ヒストグラム)
app.post('/api/reset', (req, res) => {
  let sec;
  if (req.body?.durationSec != null) sec = clampSec(req.body.durationSec);
  else if (req.body?.durationMin != null) sec = clampSec(parseInt(req.body.durationMin) * 60);
  else sec = histogramDurationSec || game.durationSec || 60;
  if (histogramDurationSec === sec) histogramCounts = [];
  broadcastState();
  res.json({ ok: true });
});

// ===== 状態取得 =====
function snapshotState() {
  const remainingMs = game.status === 'running' ? Math.max(0, game.endsAt - Date.now()) : 0;
  return {
    status: game.status,
    durationSec: game.durationSec,
    durationMs: game.durationMs,
    buttonCount: game.buttonCount,
    lightCount: game.lightCount,
    remainingMs,
    serverNow: Date.now(),
    endsAt: game.status === 'running' ? game.endsAt : 0,
    histogram: {
      durationSec: histogramDurationSec,
      counts: histogramCounts,
    },
  };
}

app.get('/api/state', (req, res) => res.json(snapshotState()));

// ===== SSE =====
function broadcastState() {
  const payload = `data: ${JSON.stringify({ type: 'state', state: snapshotState() })}\n\n`;
  for (const c of sseClients) c.write(payload);
}

setInterval(() => {
  if (game.status === 'running') broadcastState();
}, 1000);

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'state', state: snapshotState() })}\n\n`);
  sseClients.add(res);
  const ka = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
