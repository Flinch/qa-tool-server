# TC-77: Add product to cart and complete checkout

<!-- source: qa-tool test case 77 | type: e2e -->

## Scenario: TC-77 — Add product to cart and complete checkout

Starting state: app freshly launched (cleared state), on the "Products" catalog screen, not logged in.

Steps:
1. From the catalog screen, tap a product image (e.g. the first product, "Sauce Labs Backpack") to open its detail screen.
2. On the product detail screen, tap the "Add to cart" button (id: `cartBt`, a11y "Tap to add product to cart"). The cart badge (id: `cartTV`, inside `cartRL`) should update to "1".
3. Tap the "View cart" icon (id: `cartRL`) in the header to open the cart. The cart screen shows title "My Cart", the added item, item count (id: `itemsTV`) and total price (id: `totalPriceTV`).
4. Tap "Proceed To Checkout" (id: `cartBt`, a11y "Confirms products for checkout") at the bottom of the cart screen.
5. **Login is required at this point.** A "Login" screen appears (id: `loginTV`) instead of a checkout form, since the app requires authentication before checkout. Tap the sample username "bod@example.com" (id: `username1TV`) to auto-populate the username field (id: `nameET`) and password field (id: `passwordET`) with the demo credentials, then tap "Login" (id: `loginBtn`).
   <!-- Note: the on-screen username is literally "bod@example.com" (not "bob@") — confirmed from inspect_screen. -->
6. After login, the "Checkout" screen appears directly (title id: `checkoutTitleTV`, "Enter a shipping address"). **The visible field text (e.g. "Rebecca Winter", "Mandorley 112", "Truro", "89750", "United Kingdom", "Cornwall") is placeholder/hint text, not actual entered values** — tapping "To Payment" without typing real input triggers validation errors ("Please provide your full name.", "Please provide your address.", "Please provide your city.", "Please provide your zip", "Please provide your...") on the required fields (Full Name, Address Line 1, City, Zip Code, Country all marked with `*`). Fill in each required field explicitly:
   - Full Name (id: `fullNameET`)
   - Address Line 1 (id: `address1ET`)
   - City (id: `cityET`)
   - Zip Code (id: `zipET`)
   - Country (id: `countryET`)
   - Address Line 2 (id: `address2ET`) and State/Region (id: `stateET`) are optional (no `*`).
   Then tap "To Payment" (id: `paymentBtn`, a11y "Saves user info for checkout").
7. The "Checkout" payment screen appears ("Enter a payment method"). As with the shipping form, the displayed card details are placeholder/hint text, not real values — fill in the required fields:
   - Full Name (id: `nameET`)
   - Card Number (id: `cardNumberET`)
   - Expiration Date (id: `expirationDateET`)
   - Security Code (id: `securityCodeET`)
   The "My billing address is the same as my shipping address" checkbox (id: `billingAddressCB`) is checked by default. Then tap "Review Order" (id: `paymentBtn`, a11y "Saves payment info and launches screen to review checkout data").
8. The "Review your order" screen appears, showing the cart item(s), delivery address, and total (id: `totalAmountTV`). Tap "Place Order" (id: `paymentBtn`, a11y "Completes the process of checkout").

Expect: The order completes and a confirmation screen is shown with the text "Checkout Complete" (id: `completeTV`) and "Thank you for your order" (id: `thankYouTV`), along with a "Continue Shopping" button (id: `shoopingBt`).
