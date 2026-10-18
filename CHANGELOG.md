# Changelog

## 1.0.0

First public release.

### Remote control
- Live screen over H.264 (WebCodecs) with automatic fallback to screenshot frames
- Touch, typing, Back / Home / Recents / Power, shell, filtered logcat, APK install, file explorer, open URL, reverse port forwarding, identify, notes
- Android over ADB; iOS (experimental) over libimobiledevice and WebDriverAgent
- Built-in simulator (`--fake N`) for demos and tests without hardware

### Fleet
- Inventory with a query language, groups with booking windows and quotas, users and roles
- Safe reset on release (`none`, `clean`, `uninstall`) with a `cleaning` state that blocks claims
- Prometheus metrics

### Automation and CI
- Device leases with TTL, heartbeat and wait-for-free-device
- Appium gateway (`/appium`, `/wd/hub`)
- API tokens, HMAC-signed webhooks, `devicefarmz ci run | acquire | release`

### Recording
- Per-session video (mp4 when ffmpeg is available) and device log, optional auto-record

### Quality
- 41 automated tests, none needing hardware: simulator end-to-end, plus protocol mocks for adb/H.264, iOS/WebDriverAgent, OIDC and LDAP
- Fixed while writing those tests: first H.264 subscriber could miss the opening SPS/PPS/key frame; LDAP attributes returned in lower case were ignored; unsupported features (e.g. shell on iOS) now answer 501 instead of 500; plain-`http` OIDC issuers are refused unless explicitly allowed

### Sign-in
- OpenID Connect (PKCE) and LDAP, development login when neither is configured

### Assistant
- Plain-language device search and coverage-set recommendation (built-in parser, optional LLM)
