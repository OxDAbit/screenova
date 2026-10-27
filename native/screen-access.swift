// Checks or requests macOS screen-recording access for the app that launches it.
// Electron's capture APIs fail silently on recent macOS instead of showing the
// system permission dialog, so Screenova runs this to get the app into the privacy list.
//
//   screen-access check     prints "granted" or "denied"
//   screen-access request   shows the permission dialog if needed, then prints the status
import CoreGraphics

let mode = CommandLine.arguments.dropFirst().first ?? "check"
if mode == "request" && !CGPreflightScreenCaptureAccess() {
    _ = CGRequestScreenCaptureAccess()
}
print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")
