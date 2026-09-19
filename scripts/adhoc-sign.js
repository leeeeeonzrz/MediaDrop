// Ad-hoc codesign the app bundle after electron-builder assembles it.
// A valid ad-hoc signature still requires the documented Gatekeeper override,
// but avoids the misleading "app is damaged" error caused by invalid signatures.
const { execFileSync } = require("child_process");
const path = require("path");

function runCommand(executable, args) {
  execFileSync(executable, args, { stdio: "inherit" });
}

function removeProhibitedAttribute(appPath, attribute, commandRunner) {
  try {
    commandRunner("/usr/bin/xattr", ["-dr", attribute, appPath]);
  } catch (error) {
    // xattr exits with status 1 when the attribute is absent. Any attributes
    // left behind are also caught by the strict codesign verification below.
    if (!error || error.status !== 1) throw error;
  }
}

function adHocSignApp(appPath, commandRunner = runCommand, identity = "-", requirement = null) {
  console.log(`[sign] Clearing extended attributes from ${appPath}`);
  commandRunner("/usr/bin/xattr", ["-cr", appPath]);
  removeProhibitedAttribute(appPath, "com.apple.FinderInfo", commandRunner);
  removeProhibitedAttribute(appPath, "com.apple.ResourceFork", commandRunner);

  console.log(`[sign] ${identity === "-" ? "Ad-hoc" : "Certificate"} signing ${appPath}`);
  commandRunner("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, appPath]);
  commandRunner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (requirement) commandRunner("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, appPath]);
  console.log("[sign] Signing and verification complete");
}

function releaseSigningConfig(env, local = {}) {
  const identity = env.MEDIADROP_SIGNING_IDENTITY || local.identity;
  if (!identity || identity === '-') throw new Error('A stable macOS signing certificate is required. Configure MEDIADROP_SIGNING_IDENTITY or build/local-signing.json; ad-hoc release signing is disabled.');
  const requirement = env.MEDIADROP_SIGNING_REQUIREMENT || local.requirement;
  if (env.CI && !requirement) throw new Error('CI releases require MEDIADROP_SIGNING_REQUIREMENT to verify continuity with the installed application.');
  return {identity, requirement};
}
exports.releaseSigningConfig = releaseSigningConfig;

exports.adHocSignApp = adHocSignApp;
exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  // Local developer identity is kept out of Git. Never silently fall back
  // when a configured certificate fails: that would change the TCC identity.
  const fs = require("fs");
  const localConfig = path.join(__dirname, "../build/local-signing.json");
  const local = fs.existsSync(localConfig) ? JSON.parse(fs.readFileSync(localConfig,"utf8")) : {};
  const {identity, requirement} = releaseSigningConfig(process.env, local);
  adHocSignApp(path.join(appOutDir, `${appName}.app`), runCommand, identity, requirement);
};
