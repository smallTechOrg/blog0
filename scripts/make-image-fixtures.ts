// Generates tests/fixtures/images/** once (committed): sample.png 320×200, sample.jpg, sample.webp,
// tiny.gif (1 frame), sample.svg, plus sample.json with the known dimensions. Pure Node encodes the
// PNG and GIF; the JPEG and WebP are converted from the PNG with `sips` (macOS) and `cwebp`
// (Homebrew: `brew install webp`). Every raster file is round-tripped through `image-size`
// (the probe the server uses) before it is written. Run: pnpm tsx scripts/make-image-fixtures.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { imageSize } from 'image-size';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'tests', 'fixtures', 'images');
const PNG_W = 320;
const PNG_H = 200;
const GIF_W = 4;
const GIF_H = 3;

// --- PNG (RGB, 8-bit, a smooth gradient with a diagonal so JPEG/WebP conversions have content)

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3;
      const onDiagonal = Math.abs(x - Math.round((y / height) * width)) < 6;
      raw[o] = onDiagonal ? 20 : Math.round((x / width) * 255);
      raw[o + 1] = onDiagonal ? 20 : Math.round((y / height) * 255);
      raw[o + 2] = onDiagonal ? 220 : 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- GIF89a, one frame, 4 colours, LZW with a clear code before every pixel (keeps codes 3 bits wide)

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;

  write(code: number, width: number): void {
    this.acc |= code << this.n;
    this.n += width;
    while (this.n >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.n -= 8;
    }
  }

  finish(): Buffer {
    if (this.n > 0) this.bytes.push(this.acc & 0xff);
    return Buffer.from(this.bytes);
  }
}

function encodeGif(width: number, height: number): Buffer {
  const minCodeSize = 2;
  const clear = 1 << minCodeSize; // 4
  const eoi = clear + 1; // 5
  const codeWidth = minCodeSize + 1; // 3
  const bits = new BitWriter();
  bits.write(clear, codeWidth);
  for (let i = 0; i < width * height; i++) {
    bits.write(i % 4, codeWidth);
    bits.write(clear, codeWidth);
  }
  bits.write(eoi, codeWidth);
  const data = bits.finish();
  const subBlocks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const part = data.subarray(i, Math.min(i + 255, data.length));
    subBlocks.push(Buffer.from([part.length]), part);
  }
  const header = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | 0x01; // global colour table, 2 bits/pixel → 4 entries
  lsd[5] = 0;
  lsd[6] = 0;
  const palette = Buffer.from([0, 0, 0, 255, 255, 255, 220, 30, 30, 30, 90, 220]);
  const imageDescriptor = Buffer.alloc(10);
  imageDescriptor[0] = 0x2c;
  imageDescriptor.writeUInt16LE(0, 1);
  imageDescriptor.writeUInt16LE(0, 3);
  imageDescriptor.writeUInt16LE(width, 5);
  imageDescriptor.writeUInt16LE(height, 7);
  imageDescriptor[9] = 0;
  return Buffer.concat([header, lsd, palette, imageDescriptor, Buffer.from([minCodeSize]), ...subBlocks, Buffer.from([0x00, 0x3b])]);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#eee"/>
  <script>alert('never rendered')</script>
  <text x="20" y="110" font-size="32">blog0 sample.svg</text>
</svg>
`;

function check(label: string, buf: Buffer, type: string, width: number, height: number): void {
  const probed = imageSize(buf);
  if (probed.type !== type || probed.width !== width || probed.height !== height) {
    throw new Error(`${label}: image-size saw ${JSON.stringify(probed)}, expected ${type} ${width}×${height}`);
  }
  console.log(`${label}: ${type} ${width}×${height}, ${buf.length} bytes`);
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const png = encodePng(PNG_W, PNG_H);
  check('sample.png', png, 'png', PNG_W, PNG_H);
  writeFileSync(path.join(OUT, 'sample.png'), png);

  const gif = encodeGif(GIF_W, GIF_H);
  check('tiny.gif', gif, 'gif', GIF_W, GIF_H);
  writeFileSync(path.join(OUT, 'tiny.gif'), gif);

  const pngPath = path.join(OUT, 'sample.png');
  const jpgPath = path.join(OUT, 'sample.jpg');
  const webpPath = path.join(OUT, 'sample.webp');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', pngPath, '--out', jpgPath], { stdio: 'ignore' });
  execFileSync('cwebp', ['-quiet', '-q', '80', pngPath, '-o', webpPath], { stdio: 'ignore' });
  const jpg = readFileSync(jpgPath);
  const webp = readFileSync(webpPath);
  check('sample.jpg', jpg, 'jpg', PNG_W, PNG_H);
  check('sample.webp', webp, 'webp', PNG_W, PNG_H);

  writeFileSync(path.join(OUT, 'sample.svg'), SVG);

  const manifest = {
    'sample.png': { type: 'png', mime: 'image/png', width: PNG_W, height: PNG_H, bytes: png.length },
    'sample.jpg': { type: 'jpg', mime: 'image/jpeg', width: PNG_W, height: PNG_H, bytes: jpg.length },
    'sample.webp': { type: 'webp', mime: 'image/webp', width: PNG_W, height: PNG_H, bytes: webp.length },
    'tiny.gif': { type: 'gif', mime: 'image/gif', width: GIF_W, height: GIF_H, bytes: gif.length },
    'sample.svg': { type: 'svg', mime: null, width: 320, height: 200, bytes: Buffer.byteLength(SVG) },
  };
  writeFileSync(path.join(OUT, 'sample.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}

main();
