const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outputPath = path.join(__dirname, "..", "build", "medict.ico");
const sizes = [16, 32, 48, 256];
const scale = 4;

function setPixel(buffer, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const offset = (y * width + x) * 4;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = color[3];
}

function drawDisk(buffer, width, cx, cy, radius, color) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  const radiusSquared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radiusSquared) setPixel(buffer, width, x, y, color);
    }
  }
}

function drawLine(buffer, width, x1, y1, x2, y2, radius, color) {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(distance));
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    drawDisk(buffer, width, x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio, radius, color);
  }
}

function drawEllipse(buffer, width, cx, cy, rx, ry, rotation, radius, color) {
  let previous = null;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  for (let index = 0; index <= 240; index += 1) {
    const angle = (Math.PI * 2 * index) / 240;
    const sourceX = rx * Math.cos(angle);
    const sourceY = ry * Math.sin(angle);
    const x = cx + sourceX * cosine - sourceY * sine;
    const y = cy + sourceX * sine + sourceY * cosine;
    if (previous) drawLine(buffer, width, previous.x, previous.y, x, y, radius, color);
    previous = { x, y };
  }
}

function insideRoundedRect(x, y, width, height, radius) {
  const nearestX = Math.max(radius, Math.min(width - radius, x));
  const nearestY = Math.max(radius, Math.min(height - radius, y));
  return Math.hypot(x - nearestX, y - nearestY) <= radius;
}

function drawIcon(size) {
  const highSize = size * scale;
  const pixels = Buffer.alloc(highSize * highSize * 4);
  const radius = highSize * 0.19;
  for (let y = 0; y < highSize; y += 1) {
    for (let x = 0; x < highSize; x += 1) {
      if (!insideRoundedRect(x + 0.5, y + 0.5, highSize, highSize, radius)) continue;
      const gradient = y / highSize;
      setPixel(pixels, highSize, x, y, [
        Math.round(104 - gradient * 54),
        Math.round(136 - gradient * 48),
        Math.round(240 - gradient * 40),
        255
      ]);
    }
  }

  const center = highSize / 2;
  const ringColor = [255, 255, 255, 242];
  drawEllipse(pixels, highSize, center, center, highSize * 0.36, highSize * 0.14, 0, highSize * 0.026, ringColor);
  drawEllipse(pixels, highSize, center, center, highSize * 0.36, highSize * 0.14, Math.PI / 3, highSize * 0.026, ringColor);
  drawEllipse(pixels, highSize, center, center, highSize * 0.36, highSize * 0.14, -Math.PI / 3, highSize * 0.026, ringColor);
  drawDisk(pixels, highSize, center, center, highSize * 0.105, [233, 251, 255, 255]);
  drawDisk(pixels, highSize, center, center, highSize * 0.055, [39, 169, 212, 255]);

  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const sourceOffset = ((y * scale + sy) * highSize + x * scale + sx) * 4;
          const alpha = pixels[sourceOffset + 3];
          alphaSum += alpha;
          redSum += pixels[sourceOffset] * alpha;
          greenSum += pixels[sourceOffset + 1] * alpha;
          blueSum += pixels[sourceOffset + 2] * alpha;
        }
      }
      const targetOffset = (y * size + x) * 4;
      const sampleCount = scale * scale;
      const alpha = alphaSum / sampleCount;
      output[targetOffset] = alphaSum ? Math.round(redSum / alphaSum) : 0;
      output[targetOffset + 1] = alphaSum ? Math.round(greenSum / alphaSum) : 0;
      output[targetOffset + 2] = alphaSum ? Math.round(blueSum / alphaSum) : 0;
      output[targetOffset + 3] = Math.round(alpha);
    }
  }
  return output;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  payload.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(payload), 8 + data.length);
  return chunk;
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  const payloads = [];
  images.forEach((image, index) => {
    const entryOffset = index * 16;
    directory[entryOffset] = image.size === 256 ? 0 : image.size;
    directory[entryOffset + 1] = image.size === 256 ? 0 : image.size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.data.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    payloads.push(image.data);
    offset += image.data.length;
  });
  return Buffer.concat([header, directory, ...payloads]);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const images = sizes.map(size => ({ size, data: encodePng(size, drawIcon(size)) }));
fs.writeFileSync(outputPath, encodeIco(images));
console.log(`Built ${path.relative(process.cwd(), outputPath)}`);
