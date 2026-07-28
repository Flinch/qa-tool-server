# TC-87: Product Detail Page renders all required elements for a valid product

<!-- source: qa-tool test case 87 | type: e2e -->
<!-- automation rationale: Each element has a deterministic presence check that can be scripted with DOM queries and straightforward pass/fail assertions. -->
<!-- verified: 2026-07-27 against com.saucelabs.mydemoapp.android on a real Android device (Products > "Sauce Labs Backpack"). All six referenced elements genuinely exist and render as described below — no BEHAVIOR MISMATCH found. Wording below was refined for precision (real resource-ids, exact control types) per verification pass; scenario intent and step count unchanged. -->

## Scenario: TC-87 — Product Detail Page renders all required elements for a valid product

Starting state: app freshly launched.

Steps:
1. Navigate to the application and open a product detail page for a product that has an image, colors, rating, highlights, and stock quantity (e.g. tap the "Sauce Labs Backpack" product card image on the Products listing screen)
2. Observe the product image section (`id: com.saucelabs.mydemoapp.android:id/productIV`, content-desc "Displays selected product")
3. Observe the color picker section (`id: com.saucelabs.mydemoapp.android:id/colorRV`, content-desc "Displays available colors of selected product" — a horizontal list of clickable color swatches, e.g. content-desc "Black color", "Blue color", "Gray color", "Green color")
4. Observe the rating section (`id: com.saucelabs.mydemoapp.android:id/rattingV` — a row of 5 star icon ImageViews, `id`s `start1IV` through `start5IV`; this is a star-icon rating, not a numeric text value)
5. Observe the Add to Cart button (`id: com.saucelabs.mydemoapp.android:id/cartBt`, text "Add to cart", content-desc "Tap to add product to cart")
6. Scroll down past the quantity/Add to Cart row to observe the product highlights section (`id: com.saucelabs.mydemoapp.android:id/productHeightLightsTV`, text "Product Highlights", followed by a description text element `id: com.saucelabs.mydemoapp.android:id/descTV`) — this section sits below the fold and is not visible without scrolling
7. Observe the product quantity selector (`id: com.saucelabs.mydemoapp.android:id/addToCartLL` — a stepper control with a decrease button `id: minusIV` (content-desc "Decrease item quantity"), a numeric quantity display `id: noTV` (defaults to "1"), and an increase button `id: plusIV` (content-desc "Increase item quantity"); not a dropdown)

Expect: All six elements are visible and rendered on the page: a product image is displayed, a color picker with at least one selectable color option is present, a 5-star icon rating is shown, an enabled Add to Cart button is present, a "Product Highlights" heading with descriptive text is displayed (reachable by scrolling down), and a minus/plus quantity stepper defaulting to 1 is available
