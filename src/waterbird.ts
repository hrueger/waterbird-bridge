import http from "node:http";

const DEFAULT_HOST = "192.168.1.20";
const DEFAULT_PORT = 80;

// Pan range: 0x0000 (one end) → 0xFFFF (other end), 0x8000 = center
// Tilt is ignored (slider has no tilt axis), kept at 0x8000
const TILT_NEUTRAL = 0x8000;
const PAN_MIN = 0x0000;
const PAN_MAX = 0xffff;
const PAN_CENTER = 0x8000;

function httpGet(
  host: string,
  port: number,
  path: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.end();
  });
}

export class Waterbird {
  private host: string;
  private port: number;

  constructor(host = DEFAULT_HOST, port = DEFAULT_PORT) {
    this.host = host;
    this.port = port;
  }

  private async cmd(command: string): Promise<string> {
    const encoded = encodeURIComponent(`#${command}`);
    const path = `/cgi-bin/aw_ptz?cmd=${encoded}&res=1`;
    const body = await httpGet(this.host, this.port, path);
    return body.trim();
  }

  /** Returns current slider position as a fraction 0.0–1.0 */
  async getPosition(): Promise<number> {
    const res = await this.cmd("APC");
    if (!res.startsWith("aPC") || res.length < 11) {
      throw new Error(`Unexpected APC response: ${res}`);
    }
    const pan = parseInt(res.slice(3, 7), 16);
    return pan / PAN_MAX;
  }

  /** Returns raw pan/tilt hex position */
  async getRawPosition(): Promise<{ pan: number; tilt: number }> {
    const res = await this.cmd("APC");
    if (!res.startsWith("aPC") || res.length < 11) {
      throw new Error(`Unexpected APC response: ${res}`);
    }
    return {
      pan: parseInt(res.slice(3, 7), 16),
      tilt: parseInt(res.slice(7, 11), 16),
    };
  }

  /**
   * Move to absolute position.
   * @param position 0.0 = one end, 1.0 = other end, 0.5 = center
   */
  async moveTo(position: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, position));
    const pan = Math.round(clamped * PAN_MAX);
    const panHex = pan.toString(16).toUpperCase().padStart(4, "0");
    const tiltHex = TILT_NEUTRAL.toString(16).toUpperCase().padStart(4, "0");
    await this.cmd(`APC${panHex}${tiltHex}`);
  }

  /** Move to center (50%) */
  async center(): Promise<void> {
    await this.moveTo(0.5);
  }

  /** Move to one end (0%) */
  async home(): Promise<void> {
    await this.moveTo(0);
  }

  /** Move to other end (100%) */
  async end(): Promise<void> {
    await this.moveTo(1);
  }

  /**
   * Continuous pan speed (speed-based movement).
   * @param speed -1.0 (full left) to 1.0 (full right), 0 = stop
   * Panasonic PTS speed range: 01–49 (one dir), 50 (stop), 51–99 (other dir)
   */
  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.max(-1, Math.min(1, speed));
    const panSpeed = Math.round(50 + clamped * 49);
    const panStr = panSpeed.toString().padStart(2, "0");
    const tiltStr = "50"; // tilt stopped
    await this.cmd(`PTS${panStr}${tiltStr}`);
  }

  /** Stop all movement */
  async stop(): Promise<void> {
    await this.setSpeed(0);
  }

  /**
   * Wait for slider to reach a position within tolerance.
   * @param target 0.0–1.0
   * @param tolerancePct tolerance as fraction (default 0.5%)
   * @param timeoutMs max wait time
   */
  async waitForPosition(
    target: number,
    tolerancePct = 0.005,
    timeoutMs = 30000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pos = await this.getPosition();
        if (Math.abs(pos - target) <= tolerancePct) return;
      } catch {
        // device busy while moving — retry
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Timed out waiting for position ${target}`);
  }

  /** Move to position and wait until arrived */
  async moveToAndWait(position: number, timeoutMs = 30000): Promise<void> {
    await this.moveTo(position);
    await this.waitForPosition(position, 0.005, timeoutMs);
  }
}
