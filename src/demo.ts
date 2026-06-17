import { Waterbird } from "./waterbird.js";

const slider = new Waterbird();

async function main() {
  console.log("Waterbird Slider Controller");
  console.log("===========================\n");

  const pos = await slider.getPosition();
  const raw = await slider.getRawPosition();
  console.log(`Current position: ${(pos * 100).toFixed(1)}%  (pan=0x${raw.pan.toString(16).toUpperCase().padStart(4, "0")})`);

  console.log("\nMoving to center (50%)...");
  await slider.moveTo(0.5);
  await slider.waitForPosition(0.5);
  const mid = await slider.getPosition();
  console.log(`At: ${(mid * 100).toFixed(1)}%`);

  console.log("\nMoving to 25%...");
  await slider.moveToAndWait(0.25);
  console.log(`At: ${((await slider.getPosition()) * 100).toFixed(1)}%`);

  console.log("\nMoving to 75%...");
  await slider.moveToAndWait(0.75);
  console.log(`At: ${((await slider.getPosition()) * 100).toFixed(1)}%`);

  console.log("\nReturning to center...");
  await slider.moveToAndWait(0.5);
  console.log("Done.");
}

main().catch(console.error);
