const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(
  path.join(__dirname, "..", "public", "app.js"),
  "utf8"
);

assert.ok(!appJs.includes("id-multimedia"), "app.js should not use fake multimedia sink IDs");
assert.ok(!appJs.includes("id-communications"), "app.js should not use fake communications sink IDs");
assert.match(appJs, /enumerateDevices\(\)/, "app.js should enumerate real output devices");
assert.match(appJs, /device\.kind === "audiooutput"/, "app.js should filter audio output devices");
assert.match(appJs, /track\.onended = \(\) =>/, "app.js should handle local track end events");
assert.match(appJs, /track\.onmute = \(\) =>/, "app.js should handle local track mute events");
assert.match(appJs, /track\.onunmute = \(\) =>/, "app.js should handle local track unmute events");
assert.match(appJs, /mediaDevices\.addEventListener\("devicechange", handleLocalDeviceChange\)/, "app.js should listen for media device changes");

console.log("audio-path-review test passed");
