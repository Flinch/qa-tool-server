# TC-74: Add two single-digit numbers on the calculator

<!-- source: qa-tool test case 74 | type: functional -->
<!-- automation rationale: Simple, deterministic, no external side effects — good first mobile automation candidate -->

## Scenario: TC-74 — Add two single-digit numbers on the calculator

Starting state: app freshly launched (`launchApp: { clearState: true }`).

App under test: Samsung Calculator (`com.sec.android.app.popupcalculator`).

Real element ids confirmed live via `inspect_screen`:
`calc_keypad_btn_07` ("7"), `calc_keypad_btn_add` ("+"), `calc_keypad_btn_01` ("1"),
`calc_keypad_btn_equal` ("="), and the result/formula field `calc_edt_formula`.

Steps:
1. Tap "7" (`calc_keypad_btn_07`)
2. Tap "+" (`calc_keypad_btn_add`)
3. Tap "1" (`calc_keypad_btn_01`)
4. Tap "=" (`calc_keypad_btn_equal`)

Expect: `calc_edt_formula` — the result field — shows a value starting with "8".

Note for automation (confirmed live, not theoretical): `calc_edt_formula`'s real text after a calculation is
`"8 Calculation result"`, not a bare `"8"` — a full-string match on `"8"` will fail; anchor with `.*` (e.g.
`"8.*"`) or assert "starts with 8". There is a second field, `calc_tv_result` (a11y "Result preview"), which shows
a live preview of the answer ("8") only while the expression is still being typed (before "="); it goes empty once
"=" is tapped, so it is not the field to assert against for the final result — `calc_edt_formula` is. Also avoid an
unscoped `assertVisible: "8"` — the digit "8" is permanently present on the keypad regardless of whether the
calculation actually ran, so it is not a real check of the outcome.
