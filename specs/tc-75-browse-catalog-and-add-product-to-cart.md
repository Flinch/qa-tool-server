# TC-75: Browse catalog and add product to cart

<!-- source: qa-tool test case 75 | type: e2e -->

<!-- BEHAVIOR MISMATCH: expected the app to present a Products catalog screen, a product detail screen with an "Add To Cart" action, and a cart with an item-count badge; actual app under test (com.sec.android.app.popupcalculator, Samsung Calculator) is a calculator with a formula/result display (calc_edt_formula, calc_tv_result), a numeric keypad (calc_keypad_btn_00-09, calc_keypad_btn_add/sub/mul/div/equal/clear/parenthesis/percentage/dot/plusminus), and handle buttons for History, Unit converter, Scientific mode, and Backspace (calc_handle_btn_history/converter/rotation/delete). It has no catalog, product, or cart concept whatsoever. Verified via inspect_screen on device RFCR8026ZTJ on 2026-07-20. -->

## Scenario: TC-75 — Browse catalog and add product to cart

Starting state: app freshly launched.

Steps:
1. Launch the app to the Products catalog screen
2. Tap a product to open its detail screen
3. Tap Add To Cart
4. Return to the catalog and open the cart

Expect: The cart shows the added product with an accurate item count/badge on the catalog screen.
