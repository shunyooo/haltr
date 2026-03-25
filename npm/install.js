#!/usr/bin/env node

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const VERSION = require("./package.json").version;
const REPO = "shunyooo/haltr";

function getPlatformArtifact() {
  const platform = process.platform;
  const arch = process.arch;

  const map = {
    "linux-x64": "hal-linux-x64",
    "linux-arm64": "hal-linux-arm64",
    "darwin-x64": "hal-darwin-x64",
    "darwin-arm64": "hal-darwin-arm64",
    "win32-x64": "hal-win-x64.exe",
  };

  const key = `${platform}-${arch}`;
  const artifact = map[key];

  if (!artifact) {
    console.error(`Unsupported platform: ${key}`);
    console.error(`Supported: ${Object.keys(map).join(", ")}`);
    process.exit(1);
  }

  return artifact;
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "haltr-installer" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  const artifact = getPlatformArtifact();
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${artifact}`;
  const binDir = path.join(__dirname, "bin");
  const isWindows = process.platform === "win32";
  const binPath = path.join(binDir, isWindows ? "hal.exe" : "hal");

  // Skip if binary already exists
  if (fs.existsSync(binPath)) {
    return;
  }

  console.log(`Downloading hal v${VERSION} for ${process.platform}-${process.arch}...`);

  try {
    const data = await download(url);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(binPath, data);
    if (!isWindows) {
      fs.chmodSync(binPath, 0o755);
    }
    console.log("Done.");
  } catch (err) {
    console.error(`Failed to download hal binary: ${err.message}`);
    console.error(`URL: ${url}`);
    process.exit(1);
  }
}

main();
