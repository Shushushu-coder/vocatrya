// Package approved raster exports without redrawing or resampling geometry.
const fs = require("node:fs");
const path = require("node:path");

const exportsRoot = process.argv[2];
if (!exportsRoot) throw new Error("Pass the approved A1.5 PNG export directory");
const assets = path.resolve(__dirname, "../assets");
const identity = fs.readFileSync(path.join(assets, "icon.ico"));
const count = identity.readUInt16LE(4);
const entries = Array.from({ length: count }, (_, i) => {
  const offset = 6 + i * 16;
  const size = identity[offset] || 256;
  const data = identity.subarray(identity.readUInt32LE(offset + 12),
    identity.readUInt32LE(offset + 12) + identity.readUInt32LE(offset + 8));
  return { size, data };
});
for (const [symbol, color] of [["dark", "black"], ["light", "white"]]) {
  const images = entries.map(entry => ({ ...entry, data: entry.size <= 24
    ? fs.readFileSync(path.join(exportsRoot, `symbol-${color}-${entry.size}.png`)) : entry.data }));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let position = header.length;
  images.forEach(({ size, data }, i) => {
    const offset = 6 + i * 16;
    header[offset] = header[offset + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, offset + 4); header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(data.length, offset + 8); header.writeUInt32LE(position, offset + 12);
    position += data.length;
  });
  fs.writeFileSync(path.join(assets, `native-window-${symbol}-symbol.ico`),
    Buffer.concat([header, ...images.map(image => image.data)]));
}
