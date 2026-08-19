import { build } from "esbuild";
import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = join(tmpdir(), `petra-region-math-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [resolve("src/input/regions.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    logLevel: "silent",
  });
  const { logicalRectToPhysicalRegion } = await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
  const rect = { left: 10, top: 20, right: 40, bottom: 60 };
  const cases = [
    [1, { x: 8, y: 18, width: 34, height: 44 }],
    [1.25, { x: 10, y: 22, width: 43, height: 56 }],
    [1.5, { x: 12, y: 27, width: 51, height: 66 }],
    [2, { x: 16, y: 36, width: 68, height: 88 }],
  ];

  for (const [scale, expected] of cases) {
    const actual = logicalRectToPhysicalRegion("dpi", rect, scale, 2000, 2000, 2);
    assert.ok(actual, `scale ${scale} should produce a region`);
    assert.deepEqual(
      { x: actual.x, y: actual.y, width: actual.width, height: actual.height },
      expected,
      `scale ${scale}`,
    );
  }

  assert.equal(
    logicalRectToPhysicalRegion("empty", { left: 5, top: 5, right: 5, bottom: 5 }, 2, 100, 100),
    null,
  );
  console.log("input region DPI math: PASS (100%, 125%, 150%, 200%)");
} finally {
  await rm(output, { force: true });
}
