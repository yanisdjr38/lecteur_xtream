const fs = require("fs");
const path = require("path");

// Créer une icône PNG simple 256x256
const width = 256;
const height = 256;
const pixelSize = width * height * 4; // RGBA

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Créer le chunk IHDR (image header)
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type (RGBA)
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// Créer un chunk IHDR valide avec CRC
const createChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const chunkData = Buffer.concat([typeBuffer, data]);

  const crc32 = require("crypto").createHash("sha256");
  // Simpler: just use a simple format PNG

  return Buffer.concat([length, chunkData]);
};

// Pour simplifier, créer un PNG via une autre méthode
// Utiliser sharp si disponible, sinon créer une image simple

try {
  const sharp = require("sharp");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#FF6B35;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#004E89;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="256" height="256" fill="url(#grad)"/>
    <rect x="30" y="50" width="196" height="156" rx="10" fill="none" stroke="white" stroke-width="4"/>
    <circle cx="75" cy="95" r="8" fill="white"/>
    <circle cx="128" cy="95" r="8" fill="white"/>
    <circle cx="181" cy="95" r="8" fill="white"/>
    <polygon points="128,140 100,160 156,160" fill="white"/>
    <text x="128" y="200" font-family="Arial" font-size="24" font-weight="bold" fill="white" text-anchor="middle">IPTV</text>
  </svg>`;

  sharp(Buffer.from(svg))
    .resize(256, 256)
    .png()
    .toFile(path.join(__dirname, "build", "icon.png"))
    .then(() => console.log("Icon created"))
    .catch((err) => console.error("Error creating icon:", err));
} catch (e) {
  // Sharp not available, create a simple solid color PNG
  console.log("Sharp not available, creating fallback icon...");

  // Create a minimal valid PNG file
  const png = Buffer.from([
    // PNG signature
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR chunk (minimal valid)
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x08, 0x02, 0x00, 0x00, 0x00,
    // CRC (dummy but valid for minimal png)
    0x90, 0x77, 0x53, 0xde,
    // IDAT chunk (empty compressed data)
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
    // IEND chunk
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  fs.writeFileSync(path.join(__dirname, "build", "icon.png"), png);
  console.log("Fallback icon created");
}
