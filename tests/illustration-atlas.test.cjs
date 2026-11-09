const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { deflateSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { compileAtlas, checkComplete, pngInfo, jpegInfo, recordsFrom, googlePose } = require("../scripts/build-illustration-atlas.cjs");

function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; } return (value ^ 0xffffffff) >>> 0; }
function chunk(kind, data) {
  const name = Buffer.from(kind), output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); name.copy(output, 4); data.copy(output, 8); output.writeUInt32BE(crc32(Buffer.concat([name, data])), output.length - 4);
  return output;
}
function pngWithScanlines(scanlines, { encoded, interlace = 0, split = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6; header[12] = interlace;
  const compressed = encoded || deflateSync(scanlines);
  const dataChunks = split ? [chunk("IDAT", compressed.subarray(0, 3)), chunk("IDAT", compressed.subarray(3))] : [chunk("IDAT", compressed)];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...dataChunks, chunk("IEND", Buffer.alloc(0))]);
}
function png(colour) {
  const row = Buffer.from([0, colour, 80, 90, 255, colour, 80, 90, 255]);
  return pngWithScanlines(Buffer.concat([row, row]));
}
const url = (number, heading = 0) => `https://www.google.com/maps/@${43.58 + number / 1000},3.88,1534a,35y,39.03t,${heading}h/data=!3m1!1e3`;
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const detailIds = ["comedie", "saint-roch", "peyrou", "corum", "antigone"];
async function fixture(t, { complete = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tam-atlas-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public"), privateDir = path.join(directory, "private"), atlasDir = path.join(publicDir, "lab", "atlas");
  await fs.mkdir(atlasDir, { recursive: true }); await fs.mkdir(privateDir);
  const views = [{ id: "montpellier-commune", label: "Montpellier", level: "city", bounds: [3.8, 43.5, 4, 43.7], state: "available", asset: { src: "/fake.png", width: 9999, height: 9999 } }];
  const captures = [], details = [];
  for (let number = 1; number <= 24; number++) {
    const id = `montpellier-secteur-${String(number).padStart(2, "0")}`, file = `secteur-${String(number).padStart(2, "0")}-source.png`;
    views.push({ id, label: `Secteur ${number}`, level: "district", bounds: [3.8, 43.5, 4, 43.7], state: "available", source: { referenceUrl: url(number) } });
    if (complete || number === 1) {
      await fs.writeFile(path.join(atlasDir, `secteur-${String(number).padStart(2, "0")}-realiste-v3.png`), png(number));
      await fs.writeFile(path.join(privateDir, file), png(100 + number));
      captures.push({ id, file, url: url(number), verified: true });
    }
  }
  if (complete) {
    await fs.writeFile(path.join(atlasDir, "montpellier-realiste-v3.png"), png(80));
    await fs.writeFile(path.join(privateDir, "montpellier-overview-source.png"), png(90));
    for (let index = 0; index < detailIds.length; index++) {
      const id = detailIds[index], content = png(200 + index), assetPath = `/lab/atlas/${id}-realiste-v3.png`;
      await fs.writeFile(path.join(publicDir, `.${assetPath}`), content);
      details.push({ id, title: id, path: assetPath, sourceURL: url(40 + index), width: 2, height: 2, sha256: hash(content), byteLength: content.length });
    }
  }
  const planPath = path.join(privateDir, "plan.json"), capturesPath = path.join(privateDir, "captures.json"), detailsPath = path.join(atlasDir, "details-assets.json");
  const plan = { views, coverage: { theoreticalCoverageFraction: 1 }, boundary: { officialUrl: "https://example.test/boundary.geojson" } };
  await fs.writeFile(planPath, JSON.stringify(plan)); await fs.writeFile(capturesPath, JSON.stringify(captures)); await fs.writeFile(detailsPath, JSON.stringify({ assets: details }));
  return { directory, publicDir, privateDir, atlasDir, planPath, capturesPath, detailsPath, plan, captures, details,
    options: { planPath, captures: [capturesPath], publicDir, detailsPath },
    saveCaptures: () => fs.writeFile(capturesPath, JSON.stringify(captures)) };
}

test("missing images and fake available plan flags never enter the available count", async (t) => {
  const f = await fixture(t), { manifest, audit } = await compileAtlas(f.options);
  assert.equal(audit.available.total, 1); assert.equal(manifest.views["montpellier-secteur-01"].state, "available");
  assert.equal(manifest.views["montpellier-secteur-02"].state, "planned"); assert.equal(manifest.views["montpellier-commune"].asset, undefined);
  assert.equal(manifest.views["montpellier-secteur-01"].asset.width, 2);
  assert.equal(audit.referencePlan.coverageIsTheoreticalOnly, true); assert.equal(audit.referencePlan.imageRegistrationVerified, false);
  assert.equal(JSON.stringify({ manifest, audit }).includes(f.privateDir), false);
});

test("planned or invalid source URLs, unverified captures and wrong north cannot certify an image", async (t) => {
  const f = await fixture(t);
  for (const change of [{ url: "javascript:alert(1)" }, { url: "https://www.google.com/maps/@?api=1&map_action=map&center=43.6,3.8" },
    { url: url(1, 90) }, { url: undefined, requestedSourceUrl: url(1) }, { verified: false }]) {
    await fs.writeFile(f.capturesPath, JSON.stringify([{ ...f.captures[0], ...change }]));
    assert.equal((await compileAtlas(f.options)).manifest.views["montpellier-secteur-01"].state, "planned");
  }
});

test("valid PNG headers and CRCs are required; corrupt data cannot be published as an image", async (t) => {
  const f = await fixture(t), broken = png(3); broken[16] ^= 1;
  assert.throws(() => pngInfo(broken), /invalid-png/);
  await fs.writeFile(path.join(f.atlasDir, "secteur-01-realiste-v3.png"), broken);
  assert.equal((await compileAtlas(f.options)).audit.available.total, 0);
});

test("CRC-correct PNGs must contain complete decodable scanlines before becoming available", async (t) => {
  const f = await fixture(t, { complete: true }), scanlines = Buffer.alloc(18);
  assert.equal(pngInfo(pngWithScanlines(scanlines, { split: true })).width, 2);
  const badFilter = Buffer.from(scanlines); badFilter[9] = 5;
  const invalid = [
    { image: pngWithScanlines(scanlines, { encoded: Buffer.from([1, 2, 3]) }), reason: /invalid-png-image-data/ },
    { image: pngWithScanlines(scanlines.subarray(0, 17)), reason: /invalid-png-scanline-size/ },
    { image: pngWithScanlines(Buffer.alloc(19)), reason: /invalid-png-image-data/ },
    { image: pngWithScanlines(badFilter), reason: /invalid-png-filter/ },
    { image: pngWithScanlines(scanlines, { interlace: 1 }), reason: /unsupported-png-interlace/ },
  ];
  for (const { image, reason } of invalid) {
    assert.throws(() => pngInfo(image), reason);
    await fs.writeFile(path.join(f.atlasDir, "secteur-01-realiste-v3.png"), image);
    const { manifest, audit } = await compileAtlas(f.options);
    assert.equal(audit.available.total, 29);
    assert.equal(manifest.views["montpellier-secteur-01"].state, "planned");
    assert.equal(manifest.views["montpellier-secteur-01"].asset, undefined);
    assert.match(audit.issues.find((issue) => issue.id === "montpellier-secteur-01").reason, reason);
    assert.throws(() => checkComplete({ manifest, audit }), /Atlas incomplet/);
  }
});

test("JPEG captures under a .png filename preserve original byte hashes and dimensions", async (t) => {
  const f = await fixture(t);
  // Minimal marker fixture tests the header parser, not photographic decoding.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 12, 0, 20, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.equal(jpegInfo(jpeg).width, 20); assert.equal(jpegInfo(jpeg).height, 12);
  await fs.writeFile(path.join(f.privateDir, f.captures[0].file), jpeg);
  const { audit } = await compileAtlas(f.options), info = audit.integrity["montpellier-secteur-01"];
  assert.equal(info.captureFormat, "jpeg"); assert.equal(info.captureSha256, hash(jpeg));
});

test("capture records support array, nested assets and keyed object schemas without using requested links", () => {
  const capture = { id: "montpellier-secteur-01", file: "source.png", url: url(1), verified: true };
  assert.equal(recordsFrom([capture]).length, 1); assert.equal(recordsFrom({ assets: [capture] }).length, 1);
  assert.equal(recordsFrom({ captures: { "montpellier-secteur-01": { file: "source.png", url: url(1) } } })[0].id, capture.id);
  assert.equal(recordsFrom({ "montpellier-secteur-01": { file: "source.png", url: url(1) } })[0].id, capture.id);
  assert.throws(() => googlePose("https://www.google.com.evil.test/maps/@43.6,3.8,1500a,35y,39t"));
});

test("complete validation requires 30 real assets, 24 unique captures and honest geographic limits", async (t) => {
  const f = await fixture(t, { complete: true }), result = await compileAtlas(f.options);
  assert.equal(checkComplete(result), true); assert.equal(result.audit.available.total, 30);
  const target = path.join(f.privateDir, f.captures[1].file);
  await fs.copyFile(path.join(f.privateDir, f.captures[0].file), target);
  const duplicateCapture = await compileAtlas(f.options);
  assert.throws(() => checkComplete(duplicateCapture), /24 captures secteur distinctes/);
});

test("recorded checksums are checked against bytes and a complete CLI failure leaves output untouched", async (t) => {
  const f = await fixture(t, { complete: true });
  f.details[0].sha256 = "0".repeat(64);
  await fs.writeFile(f.detailsPath, JSON.stringify({ assets: f.details }));
  const result = await compileAtlas(f.options);
  assert.equal(result.manifest.views.comedie.state, "planned"); assert.match(result.audit.issues.find((issue) => issue.id === "comedie").reason, /sha256-mismatch/);
  const output = path.join(f.directory, "manifest.json"); await fs.writeFile(output, "existing-reviewed-manifest");
  const command = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/build-illustration-atlas.cjs"), "--plan", f.planPath, "--captures", f.capturesPath,
    "--details", f.detailsPath, "--public-dir", f.publicDir, "--out", output, "--check-complete"], { encoding: "utf8" });
  assert.equal(command.status, 1); assert.equal(await fs.readFile(output, "utf8"), "existing-reviewed-manifest");
});
