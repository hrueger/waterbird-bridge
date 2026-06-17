import dgram from "node:dgram";
import { Waterbird } from "./waterbird.js";

const VISCA_PORT = 52381;
const slider = new Waterbird();

// ── VISCA/IP framing ──────────────────────────────────────────────────────────
const PAYLOAD_TYPE: Record<number, string> = {
  0x0100: "Command",
  0x0110: "Inquiry",
  0x0200: "Reply/Reset",
  0x0201: "DeviceSettingCmd",
};

function hasViscaIpHeader(buf: Buffer): boolean {
  if (buf.length < 9) return false;
  const t = (buf[0]! << 8) | buf[1]!;
  const len = (buf[2]! << 8) | buf[3]!;
  return !!PAYLOAD_TYPE[t] && len === buf.length - 8;
}

function wrapReply(seqNum: number, bytes: number[]): Buffer {
  const payload = Buffer.from(bytes);
  const hdr = Buffer.alloc(8);
  hdr.writeUInt16BE(0x0200, 0);
  hdr.writeUInt16BE(payload.length, 2);
  hdr.writeUInt32BE(seqNum, 4);
  return Buffer.concat([hdr, payload]);
}

// ── Inquiry reply table (Sony camera defaults) ────────────────────────────────
// Key: hex string of the inquiry payload (without leading 8x and trailing FF)
// Value: reply payload bytes (without leading 90 and trailing FF — added below)
const INQUIRY_REPLIES: Record<string, number[]> = {
  // Lens / exposure
  "09 04 47": [0x50, 0x00, 0x00, 0x00, 0x0a],   // Shutter position
  "09 04 4b": [0x50, 0x02],                       // Slow shutter auto
  "09 04 48": [0x50, 0x03],                       // Focus mode (manual)
  "09 04 4c": [0x50, 0x01],                       // AF sensitivity (normal)
  "09 04 4a": [0x50, 0x01, 0x00, 0x00, 0x00],    // Focus near limit
  "09 04 5f": [0x50, 0x02],                       // LR reverse off
  "09 04 38": [0x50, 0x00, 0x00, 0x00, 0x0b],    // Iris position (F4)
  "09 04 35": [0x50, 0x00, 0x02],                 // Gain position (0 dB)
  "09 04 39": [0x50, 0x00, 0x07],                 // AGC limit
  "09 04 58": [0x50, 0x00, 0x07],                 // Gain limit
  "09 04 3f": [0x50, 0x00],                       // Preset recall speed
  "09 04 56": [0x50, 0x00, 0x03],                 // Zoom/focus speed
  "09 04 1a": [0x50, 0x02],                       // Back light off
  "09 04 3e": [0x50, 0x00],                       // Digital zoom off
  "09 04 4d": [0x50, 0x00],                       // IR cut filter / picture effect off
  // Color / image
  "09 04 06": [0x50, 0x00],                       // White balance (auto)
  "09 04 75": [0x50, 0x00, 0x00],                 // WB R gain
  "09 04 76": [0x50, 0x00, 0x00],                 // WB B gain
  "09 04 01": [0x50, 0x00],                       // Power / misc system
  "09 04 63": [0x50, 0x00],                       // Color hue
  "09 04 49": [0x50, 0x00],                       // Zoom/focus comp
  "09 04 43": [0x50, 0x00, 0x05],                 // Color saturation
  "09 04 44": [0x50, 0x00, 0x05],                 // Color hue
  "09 04 4e": [0x50, 0x00],                       // Noise reduction off
  "09 04 5b": [0x50, 0x02],                       // High sensitivity / WDR off
  "09 04 28": [0x50, 0x02],                       // Flicker reduction / slow shutter
  // Pan/tilt
  "09 06 06": null,                               // Pan/tilt position → dynamic (see below)
  "09 06 12": [0x50, 0x18, 0x14],                 // Pan/tilt max speed (24/20)
  "09 06 17": [0x50, 0x00, 0x00],                 // Pan/tilt status
  "09 06 44": [0x50, 0x02],                       // Pan/tilt limit off
};

// Extended (7E) replies — common Sony extended inquiries
const EXTENDED_REPLIES: Record<string, number[]> = {
  "09 7e 01 18": [0x50, 0x00],
  "09 7e 01 00": [0x50, 0x00],
  "09 7e 01 02": [0x50, 0x00],
  "09 7e 01 0e": [0x50, 0x00],
  "09 7e 7e 01": [0x50, 0x00],
  "09 7e 7e 02": [0x50, 0x00],
  "09 7e 7e 03": [0x50, 0x00],
  "09 7e 7e 05": [0x50, 0x00],
};

function inquiryKey(payload: Buffer): string {
  return [...payload]
    .slice(1, -1) // strip leading 8x and trailing FF
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

async function handleInquiry(payload: Buffer): Promise<number[] | null> {
  const key = inquiryKey(payload);

  // Pan/tilt position — query real slider position
  if (key === "09 06 06") {
    try {
      const { pan, tilt } = await slider.getRawPosition();
      return [
        0x90, 0x50,
        (pan >> 12) & 0x0f, (pan >> 8) & 0x0f, (pan >> 4) & 0x0f, pan & 0x0f,
        (tilt >> 12) & 0x0f, (tilt >> 8) & 0x0f, (tilt >> 4) & 0x0f, tilt & 0x0f,
        0xff,
      ];
    } catch {
      return [0x90, 0x50, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0xff];
    }
  }

  const reply = INQUIRY_REPLIES[key] ?? EXTENDED_REPLIES[key];
  if (reply === null) return null; // dynamic-only entry with no fallback
  return reply ? [0x90, ...reply, 0xff] : null;
}

// ── VISCA command parser (for logging) ───────────────────────────────────────
type ViscaEvent =
  | { type: "pan-tilt-drive"; panSpeed: number; tiltSpeed: number; panDir: "LEFT" | "RIGHT" | "STOP"; tiltDir: "UP" | "DOWN" | "STOP" }
  | { type: "pan-tilt-abs";   panSpeed: number; tiltSpeed: number; pan: number; tilt: number }
  | { type: "zoom-drive";     direction: "WIDE" | "TELE" | "STOP"; speed: number }
  | { type: "inquiry";        key: string }
  | { type: "unknown";        raw: string };

function parseVisca(buf: Buffer): ViscaEvent {
  const raw = [...buf].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

  if (buf[1] === 0x01 && buf[2] === 0x06 && buf[3] === 0x01 && buf.length === 9)
    return {
      type: "pan-tilt-drive",
      panSpeed: buf[4]!, tiltSpeed: buf[5]!,
      panDir: ({ 0x01: "LEFT", 0x02: "RIGHT", 0x03: "STOP" } as Record<number,string>)[buf[6]!] as "LEFT"|"RIGHT"|"STOP" ?? "STOP",
      tiltDir: ({ 0x01: "UP",   0x02: "DOWN",  0x03: "STOP" } as Record<number,string>)[buf[7]!] as "UP"|"DOWN"|"STOP" ?? "STOP",
    };

  if (buf[1] === 0x01 && buf[2] === 0x06 && buf[3] === 0x02 && buf.length === 15) {
    const pan  = (buf[6]! << 12) | (buf[7]! << 8) | (buf[8]! << 4) | buf[9]!;
    const tilt = (buf[10]! << 12) | (buf[11]! << 8) | (buf[12]! << 4) | buf[13]!;
    return { type: "pan-tilt-abs", panSpeed: buf[4]!, tiltSpeed: buf[5]!, pan, tilt };
  }

  if (buf[1] === 0x01 && buf[2] === 0x04 && buf[3] === 0x07 && buf.length === 6) {
    const p = (buf[4]! & 0xf0) >> 4;
    const speed = buf[4]! & 0x0f;
    return { type: "zoom-drive", direction: p === 0x03 ? "TELE" : p === 0x02 ? "WIDE" : "STOP", speed };
  }

  if (buf[1] === 0x09)
    return { type: "inquiry", key: inquiryKey(buf) };

  return { type: "unknown", raw };
}

function fmtEvent(ev: ViscaEvent): string {
  switch (ev.type) {
    case "pan-tilt-drive": return `PAN-TILT drive  pan=${ev.panDir}(${ev.panSpeed})  tilt=${ev.tiltDir}(${ev.tiltSpeed})`;
    case "pan-tilt-abs":   return `PAN-TILT abs  pan=0x${ev.pan.toString(16).toUpperCase().padStart(4,"0")}  tilt=0x${ev.tilt.toString(16).toUpperCase().padStart(4,"0")}`;
    case "zoom-drive":     return `ZOOM  ${ev.direction}  spd=${ev.speed}`;
    case "inquiry":        return `INQUIRY  ${ev.key}`;
    case "unknown":        return `UNKNOWN  ${ev.raw}`;
  }
}

// ── UDP server ────────────────────────────────────────────────────────────────
const sock = dgram.createSocket("udp4");

function send(bytes: Buffer | number[], port: number, addr: string) {
  sock.send(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), port, addr);
}

sock.on("message", async (msg, rinfo) => {
  const ts = new Date().toISOString().slice(11, 23);

  if (!hasViscaIpHeader(msg)) {
    // Raw VISCA
    const ev = parseVisca(msg);
    console.log(`[${ts}] ${rinfo.address}  [RAW]  ${fmtEvent(ev)}`);
    if (msg[0]! === 0x81 && msg[msg.length - 1] === 0xff && msg[1] !== 0x09) {
      send([0x90, 0x41, 0xff], rinfo.port, rinfo.address); // ACK
      send([0x90, 0x51, 0xff], rinfo.port, rinfo.address); // Completion
    }
    return;
  }

  const payloadType = (msg[0]! << 8) | msg[1]!;
  const seqNum = msg.readUInt32BE(4);
  const payload = msg.slice(8);
  const rawHex = [...msg].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

  // ── Sequence number reset (controller → camera handshake) ─────────────────
  if (payloadType === 0x0200) {
    console.log(`[${ts}] ${rinfo.address}  [SEQ-RESET]  seq=${seqNum}  → replying`);
    send(wrapReply(0, [0x01]), rinfo.port, rinfo.address);
    return;
  }

  const ev = parseVisca(payload);
  const replied = { sent: false };

  // ── Inquiry: look up canned reply ─────────────────────────────────────────
  if (payloadType === 0x0110) {
    const reply = await handleInquiry(payload);
    if (reply) {
      send(wrapReply(seqNum, reply), rinfo.port, rinfo.address);
      replied.sent = true;
      console.log(`[${ts}] ${rinfo.address}  [INQ seq=${seqNum}]  ${fmtEvent(ev)}  → replied`);
    } else {
      // Unknown inquiry — send error "not supported"
      send(wrapReply(seqNum, [0x90, 0x60, 0x03, 0xff]), rinfo.port, rinfo.address);
      console.log(`[${ts}] ${rinfo.address}  [INQ seq=${seqNum}]  ${fmtEvent(ev)}  → UNKNOWN (error sent)`);
      console.log(`         raw: ${rawHex}`);
    }
    return;
  }

  // ── Command: ACK + Completion + slider control ────────────────────────────
  if (payloadType === 0x0100) {
    send(wrapReply(seqNum, [0x90, 0x41, 0xff]), rinfo.port, rinfo.address); // ACK
    send(wrapReply(seqNum, [0x90, 0x51, 0xff]), rinfo.port, rinfo.address); // Completion

    if (ev.type === "pan-tilt-drive") {
      // VISCA pan speed 1–24 → PTS offset 1–24 (out of ±49 max)
      const magnitude = ev.panSpeed / 49;
      const speed =
        ev.panDir === "RIGHT" ? magnitude :
        ev.panDir === "LEFT"  ? -magnitude : 0;
      try { await slider.setSpeed(speed); } catch {}
    }

    console.log(`[${ts}] ${rinfo.address}  [CMD seq=${seqNum}]  ${fmtEvent(ev)}`);
    return;
  }

  console.log(`[${ts}] ${rinfo.address}  [${PAYLOAD_TYPE[payloadType] ?? "??"} seq=${seqNum}]  ${fmtEvent(ev)}`);
  console.log(`         raw: ${rawHex}`);
});

sock.on("error", (err) => { console.error("VISCA bridge error:", err); sock.close(); });

async function home() {
  process.stdout.write("Homing slider (#O1)… slider will move to find end stops\n");
  try {
    const resp = await slider.powerOn();
    process.stdout.write(`  → ${resp.split("\n")[0]}\n`);
  } catch (e) {
    process.stdout.write(`  → homing failed: ${e}\n`);
    return;
  }
  // Wait for homing sequence to complete
  process.stdout.write("  waiting 10s for homing to finish…\n");
  await new Promise((r) => setTimeout(r, 10000));
  try {
    const { pan } = await slider.getRawPosition();
    process.stdout.write(`  done — position 0x${pan.toString(16).toUpperCase().padStart(4, "0")} (${((pan / 0xffff) * 100).toFixed(1)}%)\n\n`);
  } catch {
    process.stdout.write("  done (position unavailable)\n\n");
  }
}

sock.bind(VISCA_PORT, async () => {
  console.log(`VISCA bridge  UDP :${VISCA_PORT}`);
  console.log("Handles: seq-reset handshake, inquiries (canned replies), commands (ACK+completion)\n");
  await home();
});
