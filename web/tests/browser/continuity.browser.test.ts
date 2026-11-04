import { expect, it } from "vitest";
import { MsePlayerEngine } from "@/lib/player/engine";
import { FIXTURE_CHUNKS, FIXTURE_DURATION_MS, fetchFixture, fixtureManifest } from "./fixture";

// Spec 7.4. Plays the multi-cluster fixture through the engine at real time, captures the decoded samples with an
// AudioWorklet (ScriptProcessor proved unreliable in spike S2) and checks there is no audible discontinuity at the
// cluster boundaries.

const SR = 48_000;
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const copy = new Float32Array(ch);
      this.port.postMessage({ frame: currentFrame, samples: copy }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("capture", Capture);
`;

const rms = (x: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / (to - from));
};

it("plays across cluster boundaries without a step, dip or dropped stretch", async () => {
  const audio = new Audio();
  const ctx = new AudioContext({ sampleRate: SR });
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(moduleUrl);
  const node = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1 });
  const blocks: { frame: number; samples: Float32Array }[] = [];
  node.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => blocks.push(e.data);
  ctx.createMediaElementSource(audio).connect(node);
  node.connect(ctx.destination); // the processor writes no output: silent, but keeps the graph pulled

  const fatals: string[] = [];
  const engine = new MsePlayerEngine(
    audio,
    { onBufferedEndMs() {}, onFatal: (k) => fatals.push(k), onFallback() {} },
    { fetchBytes: fetchFixture },
  );
  const ended = new Promise<void>((resolve) => audio.addEventListener("ended", () => resolve(), { once: true }));
  engine.load(fixtureManifest());
  await ctx.resume();
  await audio.play();
  // A stall must still produce numbers below, so wait for "ended" with a bound instead of until the test timeout.
  const endedInTime = await Promise.race([ended.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 32_000))]);
  await new Promise((r) => setTimeout(r, 300)); // let the worklet flush its last blocks
  engine.destroy();
  await ctx.close();
  URL.revokeObjectURL(moduleUrl);
  expect(fatals).toEqual([]);

  // Lay the blocks out by their frame number, then find where the signal is.
  const firstFrame = blocks[0]!.frame;
  const lastBlock = blocks[blocks.length - 1]!;
  const all = new Float32Array(lastBlock.frame + lastBlock.samples.length - firstFrame);
  for (const b of blocks) all.set(b.samples, b.frame - firstFrame);
  let first = 0;
  while (first < all.length && Math.abs(all[first]!) < 0.02) first++;
  let last = all.length - 1;
  while (last > first && Math.abs(all[last]!) < 0.02) last--;
  const x = all.subarray(first, last + 1);

  // Steady level over the middle second (a 0.3 amplitude sine has RMS 0.212).
  const mid = Math.floor(x.length / 2);
  const level = rms(x, mid - SR / 2, mid + SR / 2);
  expect(level).toBeGreaterThan(0.19);
  expect(level).toBeLessThan(0.23);

  // 1. No step between consecutive samples (sine max 0.0173, opus decode measured 0.0186).
  let maxStep = 0;
  for (let n = 1; n < x.length; n++) maxStep = Math.max(maxStep, Math.abs(x[n]! - x[n - 1]!));

  // 2. No dip within 50 ms of a cluster boundary (1 ms RMS windows).
  const win = SR / 1000;
  let minBoundaryRms = Infinity;
  for (const chunk of FIXTURE_CHUNKS.slice(1)) {
    const centre = Math.round((chunk.start_ms * SR) / 1000);
    for (let s = centre - 50 * win; s + win <= centre + 50 * win; s += win) {
      minBoundaryRms = Math.min(minBoundaryRms, rms(x, s, s + win));
    }
  }

  console.log(
    `continuity: max step ${maxStep.toFixed(5)}, min boundary 1 ms RMS ${minBoundaryRms.toFixed(4)} ` +
      `(level ${level.toFixed(4)}), captured ${x.length} of ${FIXTURE_DURATION_MS * 48} expected samples`,
  );
  // Dropped or stalled stretch first: it explains any NaN window below.
  expect(x.length).toBeGreaterThanOrEqual(0.98 * FIXTURE_DURATION_MS * 48);
  expect(maxStep).toBeLessThan(0.03);
  expect(Number.isFinite(minBoundaryRms)).toBe(true);
  expect(minBoundaryRms).toBeGreaterThanOrEqual(0.5 * level);

  // 3. Nothing dropped (and no long stall that would stretch playback).
  expect(x.length).toBeLessThanOrEqual(1.05 * FIXTURE_DURATION_MS * 48);
  expect(endedInTime).toBe(true);
});
