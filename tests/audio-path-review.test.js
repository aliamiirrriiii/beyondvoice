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
assert.match(appJs, /function resetLocalAudioMonitor\(\)/, "app.js should hard-disable the local monitor element");
assert.match(appJs, /function auditLocalAudioProcessing\(/, "app.js should audit applied browser audio processing state");
assert.match(appJs, /track\.applyConstraints\(retryConstraints\)/, "app.js should retry audio processing constraints when the browser ignores the first request");
assert.match(appJs, /function canEnableSpeakerOutput\(\)/, "app.js should gate speaker output on local echo safety");
assert.match(appJs, /Speaker output blocked/, "app.js should log when speaker output is refused to avoid echo");
assert.match(appJs, /localAudio\.muted = true;/, "app.js should force the local monitor element muted");
assert.match(appJs, /localAudio\.volume = 0;/, "app.js should force the local monitor element silent");
assert.doesNotMatch(appJs, /localAudio\.srcObject = state\.localStream;/, "app.js should not attach the live mic stream to the local monitor element");
assert.doesNotMatch(appJs, /localAudio\.srcObject = stream;/, "app.js should not preview freshly captured mic audio locally");
assert.match(appJs, /buildPreferredAudioConstraints\(\)/, "app.js should build capture constraints from supported browser features");
assert.match(appJs, /track\.onended = \(\) =>/, "app.js should handle local track end events");
assert.match(appJs, /track\.onmute = \(\) =>/, "app.js should handle local track mute events");
assert.match(appJs, /track\.onunmute = \(\) =>/, "app.js should handle local track unmute events");
assert.match(appJs, /mediaDevices\.addEventListener\("devicechange", handleLocalDeviceChange\)/, "app.js should listen for media device changes");

console.log("audio-path-review test passed");
