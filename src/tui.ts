import readline, { type Key } from "node:readline";
import { Waterbird } from "./waterbird.js";

const slider = new Waterbird();

// ── Step mode ────────────────────────────────────────────────────────────────
const STEPS = [
  { label: "micro  0x0020", value: 0x0020 },
  { label: "tiny   0x0080", value: 0x0080 },
  { label: "small  0x0200", value: 0x0200 },
  { label: "medium 0x0800", value: 0x0800 },
];
let stepIdx = 0;

// ── Speed mode ────────────────────────────────────────────────────────────────
// PTS: 50 = stop, 51-99 = right, 49-01 = left  (offset from 50)
const SPEEDS = [
  { label: "1  creep  (±2)",  offset: 2  },
  { label: "2  slow   (±5)",  offset: 5  },
  { label: "3  medium (±12)", offset: 12 },
  { label: "4  fast   (±25)", offset: 25 },
  { label: "5  max    (±49)", offset: 49 },
];
let speedIdx = 1;
let moving: "left" | "right" | null = null;

// ── Shared state ──────────────────────────────────────────────────────────────
type Mode = "step" | "speed";
let mode: Mode = "step";
let currentPan = 0x8000;
let polling = true;
let status = "Ready";

const BAR_WIDTH = 42;

function cls() { process.stdout.write("\x1b[2J\x1b[H"); }

function posBar(pan: number): string {
  const pos = Math.round((pan / 0xffff) * BAR_WIDTH);
  const bar = Array(BAR_WIDTH).fill("─");
  bar[Math.min(pos, BAR_WIDTH - 1)] = "●";
  return "├" + bar.join("") + "┤";
}

function render() {
  const pct  = ((currentPan / 0xffff) * 100).toFixed(1);
  const hex  = `0x${currentPan.toString(16).toUpperCase().padStart(4, "0")}`;
  const modeLabel = mode === "step" ? "STEP" : "SPEED";

  cls();
  process.stdout.write(`  Waterbird Slider Control          [ ${modeLabel} mode — Tab to switch ]\n`);
  process.stdout.write("  ──────────────────────────────────────────────────────\n");
  process.stdout.write("\n");
  process.stdout.write(`  Position   ${hex}   ${pct.padStart(5)}%\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${posBar(currentPan)}\n`);
  process.stdout.write("  0%                                                100%\n");
  process.stdout.write("\n");

  if (mode === "step") {
    const s = STEPS[stepIdx]!;
    process.stdout.write(`  Step size  ${s.label}\n`);
    process.stdout.write("\n");
    process.stdout.write("  ──────────────────────────────────────────────────────\n");
    process.stdout.write("  ←  →   move          1 2 3 4   step size      q  quit\n");
  } else {
    const s = SPEEDS[speedIdx]!;
    const arrow = moving === "right" ? "  ───────────────────────────►" :
                  moving === "left"  ? "  ◄───────────────────────────" :
                  "  ──────── stopped ────────────";
    process.stdout.write(`  Speed      ${s.label}\n`);
    process.stdout.write(`${arrow}\n`);
    process.stdout.write("  ──────────────────────────────────────────────────────\n");
    process.stdout.write("  ←  →   move   Space  stop   1 2 3 4 5  speed   q quit\n");
  }

  process.stdout.write("\n");
  process.stdout.write(`  ${status}\n`);
}

async function pollPosition() {
  while (polling) {
    try {
      const raw = await slider.getRawPosition();
      currentPan = raw.pan;
    } catch { /* busy while moving */ }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // Check power — O1 triggers a full homing run so warn first
  let powered = false;
  try { powered = await slider.isPoweredOn(); } catch {}

  if (!powered) {
    cls();
    process.stdout.write("  Waterbird Slider\n\n");
    process.stdout.write("  Slider is in standby.\n");
    process.stdout.write("  Power on will run a HOMING SEQUENCE — slider moves to both ends.\n\n");
    process.stdout.write("  P  power on + home now   (slider will move!)\n");
    process.stdout.write("  S  skip (keep current position, speed mode may not work)\n");
    process.stdout.write("  Q  quit\n\n");

    await new Promise<void>((resolve) => {
      const handler = async (_str: string, key: Key) => {
        if (key?.name === "q" || (key?.ctrl && key?.name === "c")) {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          cls(); process.exit(0);
        }
        if (key?.name === "p") {
          process.stdin.removeListener("keypress", handler);
          process.stdout.write("\n  Homing… (takes ~10s, do not interrupt)\n");
          try { await slider.powerOn(); } catch {}
          await new Promise((r) => setTimeout(r, 10000));
          resolve();
        }
        if (key?.name === "s") {
          process.stdin.removeListener("keypress", handler);
          resolve();
        }
      };
      process.stdin.on("keypress", handler);
    });
  }

  try {
    const raw = await slider.getRawPosition();
    currentPan = raw.pan;
  } catch {}

  render();
  pollPosition();
  const refreshTimer = setInterval(render, 250);

  process.stdin.on("keypress", async (_str, key) => {
    if (!key) return;

    // ── Quit ────────────────────────────────────────────────────────────────
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      polling = false;
      clearInterval(refreshTimer);
      try { await slider.stop(); } catch {}
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      cls();
      process.stdout.write("  Stopped.\n");
      process.exit(0);
    }

    // ── Mode switch ──────────────────────────────────────────────────────────
    if (key.name === "tab") {
      try { await slider.stop(); } catch {}
      moving = null;
      mode = mode === "step" ? "speed" : "step";
      status = `Switched to ${mode} mode`;
      return;
    }

    // ── Step mode ────────────────────────────────────────────────────────────
    if (mode === "step") {
      if (key.name === "right") {
        const target = currentPan + STEPS[stepIdx]!.value;
        status = `→ ${((Math.min(target, 0xffff) / 0xffff) * 100).toFixed(1)}%`;
        render();
        try { await slider.moveTo(Math.min(target, 0xffff) / 0xffff); } catch {}
        status = "Ready";
      }
      if (key.name === "left") {
        const target = currentPan - STEPS[stepIdx]!.value;
        status = `← ${((Math.max(target, 0) / 0xffff) * 100).toFixed(1)}%`;
        render();
        try { await slider.moveTo(Math.max(target, 0) / 0xffff); } catch {}
        status = "Ready";
      }
      if (["1","2","3","4"].includes(key.name)) {
        stepIdx = parseInt(key.name) - 1;
        status = `Step → ${STEPS[stepIdx]!.label}`;
      }
    }

    // ── Speed mode ───────────────────────────────────────────────────────────
    if (mode === "speed") {
      if (key.name === "right") {
        const offset = SPEEDS[speedIdx]!.offset;
        moving = "right";
        status = `Moving right at speed ${SPEEDS[speedIdx]!.label}`;
        try { await slider.setSpeed(offset / 49); } catch {}
      }
      if (key.name === "left") {
        const offset = SPEEDS[speedIdx]!.offset;
        moving = "left";
        status = `Moving left at speed ${SPEEDS[speedIdx]!.label}`;
        try { await slider.setSpeed(-(offset / 49)); } catch {}
      }
      if (key.name === "space") {
        moving = null;
        status = "Stopped";
        try { await slider.stop(); } catch {}
      }
      if (["1","2","3","4","5"].includes(key.name)) {
        speedIdx = parseInt(key.name) - 1;
        status = `Speed → ${SPEEDS[speedIdx]!.label}`;
        // If already moving, update speed immediately
        if (moving) {
          const offset = SPEEDS[speedIdx]!.offset;
          const s = moving === "right" ? offset / 49 : -(offset / 49);
          try { await slider.setSpeed(s); } catch {}
        }
      }
    }
  });
}

main().catch((err) => {
  process.stdout.write(`\nError: ${err}\n`);
  process.exit(1);
});
