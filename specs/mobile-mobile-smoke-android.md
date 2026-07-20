# Mobile Smoke (Android) — Test Plan

**App under test:** Samsung Calculator (`com.sec.android.app.popupcalculator`), stock app, Android 13
**Device:** Physical Android device (connected via adb)
**Assumption for every scenario:** app freshly launched with cleared state (`launchApp: { clearState: true }`)

Explored live via `maestro hierarchy --compact` before writing this plan. Real element ids confirmed present:
`calc_edt_formula` (the input/result field), `calc_keypad_btn_00`–`calc_keypad_btn_09`, `calc_keypad_btn_add`,
`calc_keypad_btn_sub`, `calc_keypad_btn_mul`, `calc_keypad_btn_div`, `calc_keypad_btn_equal`,
`calc_keypad_btn_clear`.

Known gotcha to design assertions around (confirmed live, not theoretical): `calc_edt_formula`'s real text after a
calculation includes a hidden `" Calculation result"` suffix not visible on screen — assertions must anchor with
`.*` rather than match the number exactly. Also: `calc_edt_formula` is the only element that should be asserted on
for a result — every digit 0-9 is permanently visible on the keypad regardless of whether a calculation ran
correctly, so an unscoped assertion on a single digit is not a real check.

### 1. Addition

#### 1.1 Add two single-digit numbers
**Steps:**
1. Tap "3"
2. Tap "+"
3. Tap "5"
4. Tap "="
**Expected:** `calc_edt_formula` shows a value starting with "8"

### 2. Subtraction

#### 2.1 Subtract two single-digit numbers
**Steps:**
1. Tap "9"
2. Tap "−"
3. Tap "4"
4. Tap "="
**Expected:** `calc_edt_formula` shows a value starting with "5"

### 3. Multiplication

#### 3.1 Multiply two single-digit numbers
**Steps:**
1. Tap "6"
2. Tap "×"
3. Tap "8"
4. Tap "="
**Expected:** `calc_edt_formula` shows a value starting with "48"

### 4. Division

#### 4.1 Divide a two-digit number by a single-digit number
**Steps:**
1. Tap "3"
2. Tap "6"
3. Tap "÷"
4. Tap "6"
5. Tap "="
**Expected:** `calc_edt_formula` shows a value starting with "6"

### 5. Clear

#### 5.1 Clear resets the input
**Steps:**
1. Tap "7"
2. Tap "C" (Clear)
**Expected:** `calc_edt_formula` no longer shows "7" — the pre-clear value is gone (empty-string text matching was
confirmed unreliable against this element during the Phase 0 spike; verify absence of the old value, not presence of
an empty one).

### 6. Percentage

#### 6.1 Percentage of a single-digit number
**Steps:**
1. Tap "5"
2. Tap "%"
3. Tap "="
**Expected:** `calc_edt_formula` shows a value starting with "0.05"
