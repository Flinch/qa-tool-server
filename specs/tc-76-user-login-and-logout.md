# TC-76: User login and logout

<!-- source: qa-tool test case 76 | type: e2e -->

<!-- BEHAVIOR MISMATCH: expected the target app (com.sec.android.app.popupcalculator) to present a catalog screen with a menu drawer containing a Login/Sign In entry, allow entering demo credentials to reach a logged-in state, and expose a logout action in that same menu; actual app is Samsung's built-in Calculator with no catalog, menu drawer, account, session, or login/logout concept whatsoever. A fresh-launch inspect_screen of the app shows only: an editable formula field (id calc_edt_formula), a result preview (id calc_tv_result), a handle row with History/Unit converter/Scientific mode/Backspace buttons (ids calc_handle_btn_history, calc_handle_btn_converter, calc_handle_btn_rotation, calc_handle_btn_delete), and a numeric keypad (ids calc_keypad_btn_00-09, calc_keypad_btn_add/sub/mul/div/equal/dot/plusminus/clear/parenthesis/percentage). There is no hamburger/drawer icon, no overflow/settings menu, and no text or resource-id referencing login, sign in, account, or logout anywhere in the hierarchy. This scenario cannot be executed against this app; do not force-fit it to unrelated calculator UI. -->

## Scenario: TC-76 — User login and logout

Starting state: app freshly launched.

Steps:
1. Open the menu drawer from the catalog screen
2. Tap Login/Sign In
3. Enter valid demo credentials and submit
4. Confirm the logged-in state, then open the menu drawer and log out

Expect: Login succeeds with valid credentials and the app returns to a logged-out state after logout.
