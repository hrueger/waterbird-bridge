import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { Waterbird } from "./waterbird.js";

const VISCA_PORT = 52381;
const PREFERRED_WEB_PORT = 7964;
let WEB_PORT = PREFERRED_WEB_PORT;
// Config lives next to the binary (SEA) or in cwd (dev)
const CONFIG_FILE = path.join(process.cwd(), "waterbird-config.json");

// ── Config ────────────────────────────────────────────────────────────────────
interface Config {
  sliderHost: string;
  maxSpeed: number; // 0–100 % of full PTS range
}
const DEFAULT_CONFIG: Config = { sliderHost: "192.168.1.20", maxSpeed: 50 };

function loadConfig(): Config {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(c: Config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

// ── Shared state ──────────────────────────────────────────────────────────────
let config  = loadConfig();
let slider  = new Waterbird(config.sliderHost);
let currentPan  = 0x8000;
let homingState: "idle" | "homing" | "done" | "error" = "idle";
let homingMsg   = "";

// Background position poll
(async () => {
  while (true) {
    try { currentPan = (await slider.getRawPosition()).pan; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
})();

// ── Homing ────────────────────────────────────────────────────────────────────
async function home() {
  if (homingState === "homing") return;
  homingState = "homing";
  homingMsg   = "Running…";
  process.stdout.write("Homing slider (#O1)… slider will move to find end stops\n");
  try {
    const resp = await slider.powerOn();
    process.stdout.write(`  → ${resp.split("\n")[0]}\n`);
  } catch (e) {
    homingState = "error";
    homingMsg   = String(e);
    process.stdout.write(`  → homing failed: ${e}\n`);
    return;
  }
  process.stdout.write("  waiting 10s for homing to finish…\n");
  await new Promise(r => setTimeout(r, 10000));
  try {
    currentPan  = (await slider.getRawPosition()).pan;
    homingState = "done";
    homingMsg   = `Done — 0x${currentPan.toString(16).toUpperCase().padStart(4,"0")} (${((currentPan/0xffff)*100).toFixed(1)}%)`;
    process.stdout.write(`  ${homingMsg}\n\n`);
  } catch {
    homingState = "done";
    homingMsg   = "Done (position unavailable)";
    process.stdout.write("  done (position unavailable)\n\n");
  }
}

// ── VISCA/IP framing ──────────────────────────────────────────────────────────
const PAYLOAD_TYPE: Record<number, string> = {
  0x0100: "Command", 0x0110: "Inquiry", 0x0200: "Reply/Reset", 0x0201: "DeviceSettingCmd",
};
function hasViscaIpHeader(buf: Buffer): boolean {
  if (buf.length < 9) return false;
  const t = (buf[0]! << 8) | buf[1]!;
  return !!PAYLOAD_TYPE[t] && ((buf[2]! << 8) | buf[3]!) === buf.length - 8;
}
function wrapReply(seq: number, bytes: number[]): Buffer {
  const p = Buffer.from(bytes), h = Buffer.alloc(8);
  h.writeUInt16BE(0x0200, 0); h.writeUInt16BE(p.length, 2); h.writeUInt32BE(seq, 4);
  return Buffer.concat([h, p]);
}

// ── Inquiry reply table ───────────────────────────────────────────────────────
const INQUIRY_REPLIES: Record<string, number[] | null> = {
  "09 04 47": [0x50,0x00,0x00,0x00,0x0a], "09 04 4b": [0x50,0x02],
  "09 04 48": [0x50,0x03],                "09 04 4c": [0x50,0x01],
  "09 04 4a": [0x50,0x01,0x00,0x00,0x00], "09 04 5f": [0x50,0x02],
  "09 04 38": [0x50,0x00,0x00,0x00,0x0b], "09 04 35": [0x50,0x00,0x02],
  "09 04 39": [0x50,0x00,0x07],           "09 04 58": [0x50,0x00,0x07],
  "09 04 3f": [0x50,0x00],                "09 04 56": [0x50,0x00,0x03],
  "09 04 1a": [0x50,0x02],                "09 04 3e": [0x50,0x00],
  "09 04 4d": [0x50,0x00],                "09 04 06": [0x50,0x00],
  "09 04 75": [0x50,0x00,0x00],           "09 04 76": [0x50,0x00,0x00],
  "09 04 01": [0x50,0x00],                "09 04 63": [0x50,0x00],
  "09 04 49": [0x50,0x00],                "09 04 43": [0x50,0x00,0x05],
  "09 04 44": [0x50,0x00,0x05],           "09 04 4e": [0x50,0x00],
  "09 04 5b": [0x50,0x02],                "09 04 28": [0x50,0x02],
  "09 06 06": null,                        // dynamic — real position
  "09 06 12": [0x50,0x18,0x14],           "09 06 17": [0x50,0x00,0x00],
  "09 06 44": [0x50,0x02],
  "09 7e 01 18": [0x50,0x00], "09 7e 01 00": [0x50,0x00],
  "09 7e 01 02": [0x50,0x00], "09 7e 01 0e": [0x50,0x00],
  "09 7e 7e 01": [0x50,0x00], "09 7e 7e 02": [0x50,0x00],
  "09 7e 7e 03": [0x50,0x00], "09 7e 7e 05": [0x50,0x00],
};

function inquiryKey(p: Buffer) {
  return [...p].slice(1,-1).map(b=>b.toString(16).padStart(2,"0")).join(" ");
}
async function handleInquiry(payload: Buffer): Promise<number[] | null> {
  const key = inquiryKey(payload);
  if (key === "09 06 06") {
    try {
      const { pan, tilt } = await slider.getRawPosition();
      return [0x90,0x50,(pan>>12)&0xf,(pan>>8)&0xf,(pan>>4)&0xf,pan&0xf,
              (tilt>>12)&0xf,(tilt>>8)&0xf,(tilt>>4)&0xf,tilt&0xf,0xff];
    } catch { return [0x90,0x50,0x00,0x08,0x00,0x00,0x00,0x08,0x00,0x00,0xff]; }
  }
  const r = INQUIRY_REPLIES[key];
  return r === undefined ? null : r === null ? null : [0x90,...r,0xff];
}

// ── VISCA parser ──────────────────────────────────────────────────────────────
type ViscaEvent =
  | { type: "pan-tilt-drive"; panSpeed: number; tiltSpeed: number; panDir: "LEFT"|"RIGHT"|"STOP"; tiltDir: "UP"|"DOWN"|"STOP" }
  | { type: "inquiry"; key: string }
  | { type: "other"; raw: string };

function parseVisca(buf: Buffer): ViscaEvent {
  if (buf[1]===0x01 && buf[2]===0x06 && buf[3]===0x01 && buf.length===9)
    return { type:"pan-tilt-drive", panSpeed:buf[4]!, tiltSpeed:buf[5]!,
      panDir: ({0x01:"LEFT",0x02:"RIGHT",0x03:"STOP"} as Record<number,string>)[buf[6]!] as any ?? "STOP",
      tiltDir: ({0x01:"UP",0x02:"DOWN",0x03:"STOP"} as Record<number,string>)[buf[7]!] as any ?? "STOP" };
  if (buf[1]===0x09) return { type:"inquiry", key:inquiryKey(buf) };
  return { type:"other", raw:[...buf].map(b=>b.toString(16).padStart(2,"0").toUpperCase()).join(" ") };
}

// ── UDP server ────────────────────────────────────────────────────────────────
const sock = dgram.createSocket("udp4");
function send(bytes: Buffer|number[], port: number, addr: string) {
  sock.send(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes), port, addr);
}

sock.on("message", async (msg, rinfo) => {
  const ts = new Date().toISOString().slice(11,23);

  if (!hasViscaIpHeader(msg)) {
    const ev = parseVisca(msg);
    if (ev.type==="pan-tilt-drive") {
      const mag = (ev.panSpeed / 24) * (config.maxSpeed / 100);
      const spd = ev.panDir==="RIGHT" ? mag : ev.panDir==="LEFT" ? -mag : 0;
      try { await slider.setSpeed(spd); } catch {}
    }
    if (msg[0]===0x81 && msg[msg.length-1]===0xff && msg[1]!==0x09) {
      send([0x90,0x41,0xff], rinfo.port, rinfo.address);
      send([0x90,0x51,0xff], rinfo.port, rinfo.address);
    }
    return;
  }

  const payloadType = (msg[0]!<<8)|msg[1]!;
  const seqNum = msg.readUInt32BE(4);
  const payload = msg.slice(8);

  if (payloadType===0x0200) {
    console.log(`[${ts}] ${rinfo.address}  [SEQ-RESET]`);
    send(wrapReply(0,[0x01]), rinfo.port, rinfo.address);
    return;
  }
  if (payloadType===0x0110) {
    const reply = await handleInquiry(payload);
    const ev = parseVisca(payload);
    if (reply) {
      send(wrapReply(seqNum,reply), rinfo.port, rinfo.address);
      if (ev.type==="inquiry") console.log(`[${ts}] ${rinfo.address}  [INQ]  ${ev.key}`);
    } else {
      send(wrapReply(seqNum,[0x90,0x60,0x03,0xff]), rinfo.port, rinfo.address);
      const raw = [...payload].map(b=>b.toString(16).padStart(2,"0").toUpperCase()).join(" ");
      console.log(`[${ts}] ${rinfo.address}  [INQ unknown]  ${raw}`);
    }
    return;
  }
  if (payloadType===0x0100) {
    send(wrapReply(seqNum,[0x90,0x41,0xff]), rinfo.port, rinfo.address);
    send(wrapReply(seqNum,[0x90,0x51,0xff]), rinfo.port, rinfo.address);
    const ev = parseVisca(payload);
    if (ev.type==="pan-tilt-drive") {
      const mag = (ev.panSpeed / 24) * (config.maxSpeed / 100);
      const spd = ev.panDir==="RIGHT" ? mag : ev.panDir==="LEFT" ? -mag : 0;
      try { await slider.setSpeed(spd); } catch {}
      console.log(`[${ts}] ${rinfo.address}  pan=${ev.panDir}(${ev.panSpeed}) spd=${spd.toFixed(2)}`);
    }
    return;
  }
});

sock.on("error", err => { console.error("VISCA error:", err); sock.close(); });

// ── Web config server ─────────────────────────────────────────────────────────
function html(): string {
  const pos   = currentPan;
  const pct   = ((pos / 0xffff) * 100).toFixed(1);
  const hex   = `0x${pos.toString(16).toUpperCase().padStart(4,"0")}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waterbird</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #111; color: #e8e8e8;
         display: flex; justify-content: center; padding: 2rem 1rem; }
  .card { background: #1c1c1c; border: 1px solid #333; border-radius: 12px;
          padding: 2rem; width: 100%; max-width: 480px; display: flex;
          flex-direction: column; gap: 1.8rem; }
  h1 { font-size: 1.1rem; font-weight: 600; color: #aaa; letter-spacing: .06em; text-transform: uppercase; }
  label { display: block; font-size: .78rem; color: #888; margin-bottom: .4rem; }
  input[type=text], input[type=number] {
    width: 100%; padding: .55rem .8rem; background: #111; border: 1px solid #444;
    border-radius: 6px; color: #e8e8e8; font-size: .9rem; }
  input:focus { outline: none; border-color: #4a9eff; }
  .row { display: flex; gap: .8rem; align-items: flex-end; }
  .row input { flex: 1; }
  input[type=range] { width: 100%; accent-color: #4a9eff; }
  .speed-row { display: flex; gap: 1rem; align-items: center; }
  .speed-val { font-size: 1.1rem; font-weight: 600; min-width: 3ch; text-align: right; }
  button { padding: .6rem 1.2rem; border: none; border-radius: 6px; cursor: pointer;
           font-size: .9rem; font-weight: 500; transition: opacity .15s; }
  button:hover { opacity: .85; }
  .btn-save { background: #4a9eff; color: #fff; }
  .btn-home { background: #e05; color: #fff; flex: 1; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
                background: #444; margin-right: .5rem; }
  .status-dot.idle    { background: #555; }
  .status-dot.homing  { background: #f90; }
  .status-dot.done    { background: #3c3; }
  .status-dot.error   { background: #e05; }
  .homing-row { display: flex; gap: .8rem; align-items: center; }
  .homing-msg { font-size: .85rem; color: #888; }
  .pos-bar-wrap { background: #111; border: 1px solid #333; border-radius: 6px;
                  height: 12px; position: relative; overflow: hidden; }
  .pos-bar-fill { height: 100%; background: #4a9eff; border-radius: 6px;
                  transition: width .3s ease; }
  .pos-label { font-size: 1.4rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .pos-sub { font-size: .8rem; color: #666; margin-top: .2rem; }
  section { display: flex; flex-direction: column; gap: .8rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Waterbird Bridge</h1>

  <section>
    <label>Slider IP address</label>
    <div class="row">
      <input type="text" id="ip" value="${config.sliderHost}" placeholder="192.168.1.20">
      <button class="btn-save" onclick="saveConfig()">Save</button>
    </div>
  </section>

  <section>
    <label>Max speed — <span id="speedLabel">${config.maxSpeed}</span>%</label>
    <div class="speed-row">
      <input type="range" id="speed" min="1" max="100" value="${config.maxSpeed}"
             oninput="document.getElementById('speedLabel').textContent=this.value">
      <button class="btn-save" onclick="saveConfig()">Save</button>
    </div>
  </section>

  <section>
    <label>Homing</label>
    <div class="homing-row">
      <button class="btn-home" onclick="doHome()">Home now</button>
      <span class="homing-msg">
        <span class="status-dot ${homingState}" id="dot"></span>
        <span id="homingMsg">${homingMsg || homingState}</span>
      </span>
    </div>
  </section>

  <section>
    <label>Current position</label>
    <div class="pos-label" id="posLabel">${pct}%</div>
    <div class="pos-sub" id="posHex">${hex}</div>
    <div class="pos-bar-wrap" style="margin-top:.6rem">
      <div class="pos-bar-fill" id="posBar" style="width:${pct}%"></div>
    </div>
  </section>
</div>

<script>
async function saveConfig() {
  const ip    = document.getElementById('ip').value.trim();
  const speed = parseInt(document.getElementById('speed').value);
  const r = await fetch('/api/config', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ sliderHost: ip, maxSpeed: speed })
  });
  const j = await r.json();
  if (j.ok) flash('btn-save');
}
async function doHome() {
  await fetch('/api/home', { method:'POST' });
}
function flash(cls) {
  document.querySelectorAll('.'+cls).forEach(b => {
    b.style.background='#3c3'; setTimeout(()=>b.style.background='',600);
  });
}
async function poll() {
  try {
    const j = await (await fetch('/api/status')).json();
    const pct = (j.pan / 0xffff * 100).toFixed(1);
    const hex = '0x' + j.pan.toString(16).toUpperCase().padStart(4,'0');
    document.getElementById('posLabel').textContent = pct + '%';
    document.getElementById('posHex').textContent   = hex;
    document.getElementById('posBar').style.width   = pct + '%';
    document.getElementById('dot').className = 'status-dot ' + j.homingState;
    document.getElementById('homingMsg').textContent = j.homingMsg || j.homingState;
  } catch {}
  setTimeout(poll, 400);
}
poll();
</script>
</body>
</html>`;
}

const web = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${WEB_PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pan: currentPan, homingState, homingMsg, config }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await new Promise<string>(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });
    try {
      const patch = JSON.parse(body);
      config = { ...config, ...patch };
      saveConfig(config);
      slider = new Waterbird(config.sliderHost); // recreate with new IP
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, config }));
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/home") {
    home(); // fire and forget — status polled via /api/status
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404); res.end("not found");
});

// ── Start ─────────────────────────────────────────────────────────────────────
function findAvailablePort(preferred: number): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => {
      const fallback = net.createServer();
      fallback.listen(0, () => {
        const port = (fallback.address() as net.AddressInfo).port;
        fallback.close(() => resolve(port));
      });
    });
    s.listen(preferred, () => { s.close(() => resolve(preferred)); });
  });
}

(async () => {
  WEB_PORT = await findAvailablePort(PREFERRED_WEB_PORT);
  if (WEB_PORT !== PREFERRED_WEB_PORT) {
    process.stderr.write(`\n⚠  Port ${PREFERRED_WEB_PORT} is in use — web UI at http://localhost:${WEB_PORT}\n\n`);
  }
  web.listen(WEB_PORT, () => {
    console.log(`Web config    http://localhost:${WEB_PORT}`);
  });
  sock.bind(VISCA_PORT, async () => {
    console.log(`VISCA bridge  UDP :${VISCA_PORT}\n`);
    await home();
  });
})();
