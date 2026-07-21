# TC-77: Add product to cart and complete checkout

<!-- source: qa-tool test case 77 | type: e2e -->

<!-- BEHAVIOR MISMATCH: expected the app under test (com.sec.android.app.popupcalculator) to expose a catalog/product-detail screen, a cart, a checkout flow with required-information fields, and an order-confirmation screen/message; actual: the app is Samsung's built-in Calculator. A fresh launch (launchApp with clearState) and full inspect_screen of com.sec.android.app.popupcalculator shows only a formula EditText (calc_edt_formula), a result TextView (calc_tv_result), handle buttons for history/unit-converter/scientific-mode/backspace (calc_handle_btn_history, calc_handle_btn_converter, calc_handle_btn_rotation, calc_handle_btn_delete), and a numeric/operator keypad (calc_keypad_btn_00..calc_keypad_btn_09, calc_keypad_btn_add, calc_keypad_btn_sub, calc_keypad_btn_mul, calc_keypad_btn_div, calc_keypad_btn_percentage, calc_keypad_btn_parenthesis, calc_keypad_btn_clear, calc_keypad_btn_dot, calc_keypad_btn_plusminus, calc_keypad_btn_equal). There is no product, cart, checkout, order, or payment concept anywhere in the app's view hierarchy, so this scenario cannot be executed against the real app as written. -->

## Scenario: TC-77 — Add product to cart and complete checkout

Starting state: app freshly launched.

Steps:
1. Add a product to the cart from the catalog or detail screen
2. Open the cart and proceed to checkout
3. Fill in required checkout information
4. Complete the order

Expect: The order completes and a confirmation screen/message is shown.
