# Phase 0 Spike — Findings

Real data from running Maestro against a physical Android device (Samsung
Galaxy S20 FE, SM-G781W, Android 13), targeting the stock Samsung Calculator
app (`com.sec.android.app.popupcalculator`) — chosen specifically to avoid
downloading any third-party APK or using client-identifying data for this
spike. 10 flows total: 5 tasks × 2 authoring methods.

## The handoff's "custom hierarchy-dump MCP adapter" already exists — built by the Maestro team

The handoff estimated a ~1-2 week build for a custom MCP adapter (4-5 tools:
launch/tap/type/dump-hierarchy/screenshot, wrapping the Maestro CLI). That
build isn't needed: **Maestro CLI 2.6.1 ships its own MCP server**,
`maestro mcp`, discovered and verified for real against the physical device
used in this spike (not just read from its tool descriptions):

- `list_devices` → real call returned the actual connected device
  (`RFCR8026ZTJ`, platform `android`, `connected: true`).
- `inspect_screen` → returns the same kind of compact, abbreviated hierarchy
  JSON this spike hand-rolled with `maestro hierarchy --compact` (see below),
  but with two things this spike had to discover the hard way already baked
  into the tool's own description: it explicitly warns "never author
  [selector text] from a screenshot, which is a common source of
  hallucinated strings" and "Maestro's `text:` matcher is full-string regex
  ... a partial string does NOT match ... anchor with a regex like
  `\"RNR 352.*\"`" — i.e. it already tells an LLM caller about the exact
  hidden-suffix and exact-match traps this spike hit and had to heal
  manually in `hierarchy-assisted/addition.yaml` and `clear.yaml`.
- `run` → real call executed a flow (`8+1=`) against the physical device,
  returned `{"success":true,"commands_executed":6}`.

**Not written to any file in this repo**: the real `inspect_screen` output
captured against this device includes on-screen notification content (Gmail,
downloads) unrelated to the app under test, including a filename referencing
a real client name — notification icons are part of the Android view
hierarchy regardless of which app is in the foreground, so any hierarchy
dump on a personal/work device can leak this. Worth remembering for Phase 1+:
CI-run device state (Device Farm / Maestro Cloud) won't have this problem
since those are ephemeral devices with no personal accounts signed in, but
any *local* real-device testing (like this spike) should stay off personal
phones with real accounts logged in, or the phone's notifications should be
cleared/disabled first.

**Bonus discovery, not yet evaluated**: the same MCP server also exposes
`list_cloud_devices` / `run_on_cloud` / `get_cloud_run_status` — Maestro
Cloud, a first-party device-hosting service. The handoff chose AWS Device
Farm specifically for cost ($0.17/device-minute vs. TestSigma's enterprise
licensing) without knowing Maestro Cloud existed as an option. Worth a real
pricing/tradeoff comparison before Phase 1 commits to the AWS Device Farm
path this spike already built scripts for — flagged, not evaluated here.

## Question: does a real `maestro hierarchy` dump measurably help generation?

**Answer: yes, dramatically — and not primarily in the way the handoff
predicted.** The expected benefit was "fewer heal iterations." The actual,
larger finding: **blind (screenshot/description-only) assertions on this UI
were not actually testing anything.**

### What happened

**Blind set** (`mobile-spike/flows/blind/*.yaml`) — flows authored using only
visible button text/symbols, exactly what a screenshot or text description
would show. No `maestro hierarchy` consulted.

| Flow | Result | Why |
|---|---|---|
| addition (2+2=4) | "Passed" | **False positive** — `assertVisible: "4"` matched the permanently-on-screen digit key `calc_keypad_btn_04`, not the calculation result |
| subtraction (9-3=6) | "Passed" | Same false positive, matched digit key `calc_keypad_btn_06` |
| multiplication (6×7=42) | **Failed** | No single keypad button reads "42" (all keys are single digits 0-9), so there was nothing to accidentally match — this is the one flow that failed *honestly*, but a blind author has no way to diagnose why, since the actual UI text (`"42 Calculation result"`) is invisible in a screenshot |
| division (20÷4=5) | "Passed" | False positive, matched digit key `calc_keypad_btn_05` |
| clear (5, then C) | "Passed" | False positive, matched digit key `calc_keypad_btn_00` |

**Every single-digit-result blind flow "passed" for the wrong reason.**
`assertVisible` with no element scope searches the entire screen, and every
digit 0-9 is permanently visible on the keypad regardless of whether the
calculation actually ran correctly. These assertions would still report
"passed" if the app crashed back to a blank calculator, or if the math were
wrong — as long as the *correct digit happened to also be a key on the
keypad*, which for single-digit results it always is. This is a real,
reproducible instance of the exact failure mode the original TestSigma
evaluation flagged: **"a test could report passed while landing on the wrong
screen."**

**Hierarchy-assisted set** (`mobile-spike/flows/hierarchy-assisted/*.yaml`) —
flows authored from a real `maestro hierarchy --compact` dump, using the
actual `resource-id` of the result field (`calc_edt_formula`) to scope every
assertion to the one element that actually matters.

| Flow | First try | Heal | Root cause found via hierarchy |
|---|---|---|---|
| addition | Failed | 1 iteration → passed | Real field text is `"4 Calculation result"`, not `"4"` — Samsung appends an accessibility-only suffix invisible on screen. Fixed with a `"4.*"` regex once the real text was visible in the dump. |
| subtraction | Passed | 0 | Applied the lesson from addition immediately |
| multiplication | Passed | 0 | Same |
| division | Passed | 0 | Same |
| clear | Failed | 1 iteration → passed | A truly-empty string doesn't match via `assertVisible` + regex `"^$"` against this element (a real Maestro/Espresso quirk with empty EditText text matching) — switched to `assertNotVisible` on the pre-clear value instead, which is also a more meaningful check of "did clear actually happen" than "is the field empty." |

**5/5 hierarchy-assisted flows end up correctly verifying real behavior, 0
false positives, 2 real heal iterations total** (both genuine tooling/UI
quirks, each diagnosed *because* the raw hierarchy text was visible — neither
would have been discoverable, let alone fixable, from a screenshot alone).

### Why this matters more than a heal-iteration count

The handoff framed this as a heal-iteration-count comparison. The real
finding is a level more serious: on this real app, **blind generation didn't
produce fewer correct tests that needed more healing — it produced tests that
mostly don't test anything**, passing by coincidence rather than by
verification. A wider heal budget (Phase 0 spike option 2 from the handoff,
"execution-only feedback loop") wouldn't have caught this, because the
flows *were reporting green*. Only having the real element tree exposed the
gap between "the screen shows the right digit somewhere" and "the field that
actually holds the result shows the right value."

### Recommendation

This is real evidence for **Option 1 from the handoff — the custom
hierarchy-dump MCP adapter** — over Option 2 (execution-only healing) or
Option 3 (blind generation). Blind generation isn't just less efficient here,
it's not trustworthy for assertions on any screen with digit/short-string
keypads, counters, or repeated character sets, which describes a lot of real
mobile UI (any numeric input, ratings, quantities, etc.).

## Correction to the handoff: `--simple` flag doesn't exist

The handoff cites `maestro hierarchy --simple` as the "LLM-optimized
hierarchy output" flag, referencing a merged PR on Maestro's GitHub. On the
current stable CLI actually installed here (**Maestro 2.6.1**), that flag
doesn't exist:

```
$ maestro hierarchy --simple
Unknown option: '--simple'
```

What exists instead: plain `maestro hierarchy` (full nested JSON tree — 2319
lines for one Calculator screen, too verbose to hand an LLM directly) and
`maestro hierarchy --compact` (flat CSV: `element_num,depth,attributes,
parent_num` — 100 lines for the same screen, ~23x smaller, and what this
spike actually used for every hierarchy-assisted flow above). Either the
`--simple` PR hasn't shipped to a stable release yet, or it landed under a
different name. **The adapter design in Phase 2 should target `--compact`**,
or re-check `maestro hierarchy --help` against whatever CLI version is
current at that time.

## Environment notes for Phase 1/2 planning

- Local dev tooling installed and confirmed working on this machine: Java
  (OpenJDK 26 via Homebrew, keg-only — needs
  `/opt/homebrew/opt/openjdk/bin` on `PATH`, added to `~/.zshrc`), Maestro CLI
  2.6.1 (official installer, added itself to `~/.zshrc`/`~/.bash_profile`),
  `android-platform-tools` (Homebrew cask, gives `adb`).
- Real device testing needs **USB debugging explicitly enabled** in Developer
  Options (separate toggle from just unlocking Developer Options), a
  data-capable USB cable, and the device unlocked/awake — screen timeout was
  bumped to 30 minutes for this session (`adb shell settings put system
  screen_off_timeout 1800000`) since Maestro can't dismiss a lock screen.
- iOS was not attempted this session — this machine only has Xcode Command
  Line Tools, not full Xcode, so there's no iOS Simulator available. Full
  Xcode is a large (many-GB), opinionated install (App Store / Apple
  Developer account) that wasn't done without checking first. **Still open**:
  does `maestro hierarchy --compact` (or whatever the current flag is) carry
  the same signal on iOS's XCTest-based driver as it did here on Android's
  UiAutomator-based one? Needs its own pass before the MCP adapter is
  designed for both platforms.

## AWS Device Farm (open question #1 from the handoff)

Not resolved this session — no AWS account exists yet. `device-farm-test-
spec.yml` and `scripts/device-farm-run.js` in this directory are written
against AWS's documented Custom Test Environment format and the existing
webhook contract, but are **untested against a live account**. See
`AWS-SETUP-RUNBOOK.md` for the handoff steps to close this out.
