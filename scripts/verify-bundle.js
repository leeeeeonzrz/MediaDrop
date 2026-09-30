const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { verifyFfmpeg } = require("./verify-ffmpeg");

const root = path.join(__dirname, "..");
const defaultAppPath = path.join(root, "dist", "mac-arm64", "MediaDrop.app");
const requiredFonts = [
  path.join("_internal", "fonts", "Roboto-Medium.ttf"),
  path.join("_internal", "fonts", "NotoSansCJKsc-Regular.otf"),
  path.join("_internal", "fonts", "Roboto-OFL.txt"),
  path.join("_internal", "fonts", "NotoSansCJK-OFL.txt"),
];

function verifyMacAppSignature(appPath, commandRunner = execFileSync) {
  commandRunner(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" },
  );
}

function verifyBundle(appPath = defaultAppPath) {
  const appBinDir = path.join(appPath, "Contents", "Resources", "bin");
  const required = ["mediadrop-server", "yt-dlp", "ffmpeg", "ffprobe", "youtube/yt-dlp-sabr"];

  for (const name of required) {
    const file = path.join(appBinDir, name);
    if (!fs.existsSync(file)) {
      throw new Error(`Missing bundled binary: ${file}`);
    }
    fs.accessSync(file, fs.constants.X_OK);
  }

  for (const relative of requiredFonts) {
    const file = path.join(appBinDir, relative);
    if (!fs.existsSync(file)) {
      throw new Error(`Missing bundled subtitle font resource: ${file}`);
    }
  }

  for (const name of ["server/build/main.js", "server/node_modules/canvas/build/Release/canvas.node", "plugin/yt_dlp_plugins", "mediadrop/yt_dlp_plugins/extractor/mediadrop_player.py", "mediadrop/yt_dlp_plugins/extractor/_mediadrop_policy.py", "manifest.json"]) {
    if (!fs.existsSync(path.join(appBinDir, "youtube", name))) throw new Error(`Missing YouTube component: ${name}`);
  }
  if (!fs.existsSync(path.join(appPath, "Contents", "Resources", "native", "liquid-glass.node"))) throw new Error("Missing native Liquid Glass bridge");
  verifyFfmpeg(path.join(appBinDir, "ffmpeg"), "arm64", "8.1.2");
  verifyMacAppSignature(appPath);

  console.log(`Bundle verification passed: signature, ${required.join(", ")} and subtitle fonts`);
}

if (require.main === module) {
  verifyBundle(process.argv[2]);
}

module.exports = { verifyBundle, verifyMacAppSignature };
