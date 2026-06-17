import readline from "node:readline";
import { Waterbird } from "./waterbird.js";

const slider = new Waterbird();

// Step sizes as fraction of full range (0x0000–0xFFFF = 65535)
const STEPS = [
  { label: "1  micro  (0x0020 ~0.05%)", value: 0x0020 },
  { label: "2  tiny   (0x0080 ~0.2%)",  value: 0x0080 },
  { label: "3  small  (0x0200 ~0.8%)",  value: 0x0200 },
  { label: "4  medium (0x0800 ~3%)",    value: 0x0800 },
];
let stepIdx = 0;
let currentPan = 0x8000;
let polling = true;

const BAR_WIDTH = 42;

function cls() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function posBar(pan: number): string {
  const pct = pan / 0xffff;
  const pos = Math.round(pct * BAR_WIDTH);
  const bar = Array(BAR_WIDTH).fill("─");
  bar[Math.min(pos, BAR_WIDTH - 1)] = "●";
  return "├" + bar.join("") + "┤";
}

function speedBar(idx: number): string {
  return STEPS.map((s, i) => (i === idx ? `[${s.label}]` : ` ${s.label} `)).join("  ");
}

function render(pan: number, status: string) {
  const pct = ((pan / 0xffff) * 100).toFixed(1);
  const hexStr = `0x${pan.toString(16).toUpperCase().padStart(4, "0")}`;

  cls();
  process.stdout.write("  Waterbird Slider Control\n");
  process.stdout.write("  ──────────────────────────────────────────────────\n");
  process.stdout.write("\n");
  process.stdout.write(`  Position   ${hexStr}   ${pct.padStart(5)}%\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${posBar(pan)}\n`);
  process.stdout.write("  0%                                             100%\n");
  process.stdout.write("\n");
  process.stdout.write(`  Speed      ${STEPS[stepIdx]!.label}\n`);
  process.stdout.write("\n");
  process.stdout.write("  ──────────────────────────────────────────────────\n");
  process.stdout.write("  ←  →   move      1 2 3 4   speed      0  stop      q  quit\n");
  process.stdout.write("\n");
  process.stdout.write(`  ${status}\n`);
}

async function moveTo(target: number) {
  const clamped = Math.max(0x0000, Math.min(0xffff, target));
  try {
    await slider.moveTo(clamped / 0xffff);
    currentPan = clamped;
  } catch {
    // ignore during movement
  }
  return clamped;
}

async function pollPosition() {
  while (polling) {
    try {
      const raw = await slider.getRawPosition();
      currentPan = raw.pan;
    } catch {
      // device busy while moving — skip
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  try {
    const raw = await slider.getRawPosition();
    currentPan = raw.pan;
  } catch {
    currentPan = 0x8000;
  }

  let status = "Ready  — use arrow keys to move";
  render(currentPan, status);

  pollPosition();

  const refreshTimer = setInterval(() => {
    render(currentPan, status);
  }, 250);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on("keypress", async (_str, key) => {
    if (!key) return;

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      polling = false;
      clearInterval(refreshTimer);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      cls();
      process.stdout.write("  Stopped.\n");
      process.exit(0);
    }

    if (key.name === "right") {
      const target = currentPan + STEPS[stepIdx]!.value;
      status = `→ ${((Math.min(target, 0xffff) / 0xffff) * 100).toFixed(1)}%`;
      render(currentPan, status);
      await moveTo(target);
      status = "Ready";
    }

    if (key.name === "left") {
      const target = currentPan - STEPS[stepIdx]!.value;
      status = `← ${((Math.max(target, 0) / 0xffff) * 100).toFixed(1)}%`;
      render(currentPan, status);
      await moveTo(target);
      status = "Ready";
    }

    if (["1", "2", "3", "4"].includes(key.name)) {
      stepIdx = parseInt(key.name) - 1;
      status = `Speed → ${STEPS[stepIdx]!.label}`;
    }

    if (key.name === "0") {
      try { await slider.stop(); } catch {}
      status = "Stopped";
    }
  });
}

main().catch((err) => {
  process.stdout.write(`\nError: ${err}\n`);
  process.exit(1);
});
