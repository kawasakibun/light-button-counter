const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

let count = 0;
const sseClients = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ESP-WROOM-02 からの POST を受ける
app.post('/api/count', (req, res) => {
  count += 1;
  console.log(`[hit] count=${count} from ${req.ip}`);
  broadcast({ count });
  res.json({ ok: true, count });
});

// 現在のカウント取得
app.get('/api/count', (req, res) => {
  res.json({ count });
});

// 手動リセット (任意)
app.post('/api/reset', (req, res) => {
  count = 0;
  broadcast({ count });
  res.json({ ok: true, count });
});

// Server-Sent Events: ブラウザにリアルタイム push
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ count })}\n\n`);
  sseClients.add(res);

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
