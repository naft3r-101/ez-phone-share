const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const EventEmitter = require('events');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const events = new EventEmitter();
let mediaDir = path.join(os.tmpdir(), 'ez-phone-share');
let serverPort = 3000;
let uploadToken = null;

function generateToken() { return crypto.randomBytes(9).toString('base64url'); }
function setUploadToken(t) { uploadToken = t || generateToken(); events.emit('token-changed', uploadToken); return uploadToken; }
function getUploadToken() { return uploadToken; }

function requireToken(req, res, next) {
  if (!uploadToken || req.params.token !== uploadToken) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
}

let watcher = null;
let watchDebounce = null;
function startWatching(dir) {
  if (watcher) { try { watcher.close(); } catch { /* noop */ } watcher = null; }
  try {
    watcher = fs.watch(dir, { persistent: false }, (_evt, _name) => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => broadcast('files-changed', { folder: mediaDir }), 250);
    });
    watcher.on('error', (e) => console.warn('watcher error:', e.message));
  } catch (e) {
    console.warn('Cannot watch ' + dir + ':', e.message);
  }
}

function setMediaDir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  mediaDir = dir;
  startWatching(dir);
  events.emit('media-dir-changed', dir);
}
function getMediaDir() { return mediaDir; }
function getPort() { return serverPort; }

function listCandidates() {
  const ifs = os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifs)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      out.push({ name, addr: i.address });
    }
  }
  return out;
}
function scoreCandidate(c) {
  let s = 0;
  if (/vethernet|wsl|hyper-?v|docker|virtualbox|vmware|vbox|loopback|tunnel|tap/i.test(c.name)) s -= 100;
  if (/^192\.168\./.test(c.addr)) s += 50;
  else if (/^10\./.test(c.addr)) s += 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.addr)) s += 5;
  if (/wi-?fi|wlan|wireless/i.test(c.name)) s += 20;
  else if (/^ethernet/i.test(c.name)) s += 10;
  return s;
}
function pickLanIp(override) {
  if (override) return override;
  const all = listCandidates();
  if (!all.length) return 'localhost';
  return all.map(c => ({ ...c, score: scoreCandidate(c) })).sort((a, b) => b.score - a.score)[0].addr;
}
function getLanUrl() {
  const base = `http://${pickLanIp(process.env.HOST)}:${serverPort}`;
  return uploadToken ? `${base}/s/${uploadToken}` : base;
}

const sseClients = new Set();
function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch { /* drop */ }
  }
}

function localOnly(req, res, next) {
  const ip = (req.ip || '').replace('::ffff:', '');
  if (ip === '127.0.0.1' || ip === '::1') return next();
  res.status(403).send('Localhost only');
}

function isMediaFile(name) {
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|mp4|mov|m4v|webm|avi|mkv)$/i.test(name);
}
function isImage(name) { return /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(name); }
function isVideo(name) { return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(name); }
function fileInfo(name) {
  const full = path.join(mediaDir, name);
  let stat;
  try { stat = fs.statSync(full); } catch { return null; }
  if (!stat.isFile()) return null;
  return {
    name,
    size: stat.size,
    mtime: stat.mtimeMs,
    type: isImage(name) ? 'image' : isVideo(name) ? 'video' : 'file',
    path: full,
  };
}
function listRecent(limit = 200) {
  let names;
  try { names = fs.readdirSync(mediaDir); } catch { return []; }
  return names
    .map(fileInfo)
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, mediaDir),
  filename: (_req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const app = express();
app.disable('x-powered-by');

// ---------- Phone-facing upload page (token-gated) ----------
app.get('/s/:token', requireToken, (_req, res) => {
  res.type('html').send(UPLOAD_PAGE_HTML);
});
// Allow trailing slash too
app.get('/s/:token/', requireToken, (_req, res) => {
  res.type('html').send(UPLOAD_PAGE_HTML);
});

app.post('/s/:token/upload', requireToken, upload.array('files'), (req, res) => {
  const files = req.files || [];
  for (const f of files) {
    const info = fileInfo(f.filename);
    if (info) {
      events.emit('upload', info);
      broadcast('upload', info);
    }
  }
  res.json({ ok: true, count: files.length });
});

// Root and legacy /upload return a helpful 404 so people understand
app.get('/', (_req, res) => {
  res.status(404).type('text/plain').send('Ez Phone Share: open the dashboard on the host PC to get the upload URL with a one-time token.');
});
app.post('/upload', (_req, res) => res.status(404).type('text/plain').send('Not found'));

// ---------- Dashboard (localhost only) ----------
app.get('/dashboard', localOnly, (_req, res) => {
  try {
    res.type('html').send(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
  } catch (e) {
    res.status(500).send('Dashboard missing: ' + e.message);
  }
});

app.get('/api/info', localOnly, async (_req, res) => {
  const url = getLanUrl();
  let qr;
  try { qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 360 }); }
  catch (e) { qr = null; }
  res.json({
    url,
    folder: mediaDir,
    qrSvg: qr,
    interfaces: listCandidates(),
  });
});

app.get('/api/files', localOnly, (_req, res) => {
  res.json({ folder: mediaDir, files: listRecent() });
});

app.post('/api/rotate-token', localOnly, (_req, res) => {
  setUploadToken(generateToken());
  broadcast('token-rotated', { url: getLanUrl() });
  res.json({ ok: true, url: getLanUrl(), token: uploadToken });
});

app.get('/api/thumb/:name', localOnly, (req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(mediaDir, name);
  if (!full.startsWith(mediaDir) || !fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

app.get('/events', localOnly, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function start(port) {
  return new Promise((resolve, reject) => {
    serverPort = port;
    const server = app.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = {
  start,
  app,
  events,
  setMediaDir,
  getMediaDir,
  getPort,
  getLanUrl,
  setUploadToken,
  getUploadToken,
  generateToken,
  listCandidates,
  broadcast,
  listRecent,
};

// ---------------- Upload page HTML (served at /) ----------------
const UPLOAD_PAGE_HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Send to PC</title>
<style>
  :root { --blue: #007aff; --bg: #f5f5f7; --card: #fff; --line: #e5e5ea; --muted: #6e6e73; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0 auto; padding: 1.25rem; max-width: 560px; background: var(--bg); color: #111; padding-bottom: 9rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  .pickers { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
  label.drop { display: flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.9rem 0.6rem; border: 2px dashed #b5b5bb; border-radius: 14px; cursor: pointer; background: var(--card); font-size: 0.95rem; font-weight: 500; text-align: center; }
  label.drop:active { background: #eee; }
  input[type=file] { display: none; }
  .preview { margin-top: 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 0.55rem; }
  .tile { position: relative; aspect-ratio: 1 / 1; background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--line); }
  .tile img, .tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile .ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; color: var(--muted); }
  .tile .meta { position: absolute; left: 0; right: 0; bottom: 0; padding: 0.25rem 0.4rem; color: white; font-size: 0.7rem; line-height: 1.15; background: linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0)); }
  .tile .meta .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile .rm { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: 0; border-radius: 50%; background: rgba(0,0,0,0.65); color: white; font-size: 14px; line-height: 1; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
  .tile .badge { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.6); color: white; font-size: 0.65rem; padding: 1px 6px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.03em; }
  .empty { margin-top: 1rem; padding: 1.2rem; border: 1px dashed var(--line); border-radius: 12px; text-align: center; color: var(--muted); font-size: 0.9rem; background: var(--card); }
  .bottom { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(245,245,247,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-top: 1px solid var(--line); padding: 0.75rem 1.25rem calc(0.75rem + env(safe-area-inset-bottom)); }
  .bottom .inner { max-width: 560px; margin: 0 auto; }
  .summary { display: flex; justify-content: space-between; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; min-height: 1.1rem; }
  button.primary { width: 100%; padding: 0.95rem; font-size: 1.05rem; font-weight: 600; border: 0; border-radius: 12px; background: var(--blue); color: white; cursor: pointer; }
  button.primary:disabled { background: #b5b5bb; }
  button.clear { background: none; border: 0; color: var(--blue); font-size: 0.85rem; padding: 0; cursor: pointer; }
  .bar { height: 4px; background: #ddd; border-radius: 2px; overflow: hidden; margin-top: 0.55rem; display: none; }
  .bar > div { height: 100%; width: 0%; background: var(--blue); transition: width 0.15s; }
  #log { margin-top: 0.55rem; font-size: 0.9rem; min-height: 1.1rem; text-align: center; }
  .ok { color: #137333; } .err { color: #c5221f; }
</style>
</head><body>
<h1>Send to media folder</h1>
<div class="pickers">
  <label class="drop">📷 Take photo<input type="file" id="cam" accept="image/*" capture="environment" multiple></label>
  <label class="drop">🖼️ From library<input type="file" id="lib" accept="image/*,video/*" multiple></label>
</div>
<div id="preview" class="preview"></div>
<div id="empty" class="empty">No files selected yet. Tap one of the buttons above.</div>
<div class="bottom"><div class="inner">
  <div class="summary">
    <span id="summary">0 files</span>
    <button type="button" id="clear" class="clear" style="display:none">Clear all</button>
  </div>
  <button type="button" class="primary" id="btn" disabled>Upload</button>
  <div class="bar" id="bar"><div></div></div>
  <div id="log"></div>
</div></div>
<script>
const cam = document.getElementById('cam');
const lib = document.getElementById('lib');
const preview = document.getElementById('preview');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');
const clearBtn = document.getElementById('clear');
const btn = document.getElementById('btn');
const bar = document.getElementById('bar');
const barInner = bar.firstElementChild;
const log = document.getElementById('log');
let nextId = 1;
const items = [];
function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / (1024 * 1024)).toFixed(1) + ' MB'; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function render() {
  preview.innerHTML = '';
  for (const it of items) {
    const tile = document.createElement('div'); tile.className = 'tile';
    const isImg = it.file.type.startsWith('image/');
    const isVid = it.file.type.startsWith('video/');
    let media;
    if (isImg) { media = document.createElement('img'); media.src = it.url; media.alt = it.file.name; }
    else if (isVid) { media = document.createElement('video'); media.src = it.url; media.muted = true; media.playsInline = true; media.preload = 'metadata'; }
    else { media = document.createElement('div'); media.className = 'ph'; media.textContent = '📄'; }
    tile.appendChild(media);
    if (isVid) { const b = document.createElement('div'); b.className = 'badge'; b.textContent = 'video'; tile.appendChild(b); }
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = '<div class="name">' + esc(it.file.name) + '</div><div class="size">' + fmtSize(it.file.size) + '</div>';
    tile.appendChild(meta);
    const rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '×';
    rm.addEventListener('click', () => removeItem(it.id));
    tile.appendChild(rm);
    preview.appendChild(tile);
  }
  const total = items.reduce((a, it) => a + it.file.size, 0);
  summary.textContent = items.length === 0 ? '0 files' : items.length + ' file' + (items.length === 1 ? '' : 's') + ' • ' + fmtSize(total);
  btn.disabled = items.length === 0;
  btn.textContent = items.length === 0 ? 'Upload' : 'Upload ' + items.length + ' file' + (items.length === 1 ? '' : 's');
  empty.style.display = items.length === 0 ? '' : 'none';
  clearBtn.style.display = items.length === 0 ? 'none' : '';
}
function addFiles(fl) { for (const f of fl) items.push({ id: nextId++, file: f, url: URL.createObjectURL(f) }); render(); }
function removeItem(id) { const i = items.findIndex(x => x.id === id); if (i < 0) return; URL.revokeObjectURL(items[i].url); items.splice(i, 1); render(); }
function clearAll() { for (const it of items) URL.revokeObjectURL(it.url); items.length = 0; render(); }
cam.addEventListener('change', () => { addFiles(cam.files); cam.value = ''; });
lib.addEventListener('change', () => { addFiles(lib.files); lib.value = ''; });
clearBtn.addEventListener('click', clearAll);
btn.addEventListener('click', () => {
  if (!items.length) return;
  const fd = new FormData();
  for (const it of items) fd.append('files', it.file, it.file.name);
  btn.disabled = true; clearBtn.disabled = true;
  bar.style.display = 'block'; barInner.style.width = '0%'; log.innerHTML = '';
  const base = location.pathname.replace(/\\/$/, '');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', base + '/upload');
  xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) barInner.style.width = (ev.loaded / ev.total * 100) + '%'; };
  xhr.onload = () => {
    clearBtn.disabled = false; bar.style.display = 'none';
    if (xhr.status >= 200 && xhr.status < 300) { const n = items.length; log.innerHTML = '<span class="ok">✓ Uploaded ' + n + ' file' + (n === 1 ? '' : 's') + '</span>'; clearAll(); }
    else { btn.disabled = false; log.innerHTML = '<span class="err">Failed: ' + xhr.status + '</span>'; }
  };
  xhr.onerror = () => { btn.disabled = false; clearBtn.disabled = false; bar.style.display = 'none'; log.innerHTML = '<span class="err">Network error</span>'; };
  xhr.send(fd);
});
render();
</script>
</body></html>`;
