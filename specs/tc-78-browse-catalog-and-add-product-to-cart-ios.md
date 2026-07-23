# TC-78: Browse catalog and add product to cart (iOS)

<!-- source: qa-tool test case 78 | type: e2e -->

## Scenario: TC-78 — Browse catalog and add product to cart (iOS)

Starting state: app freshly launched (cleared state), landing on the Products
catalog screen (resource-id `Catalog-screen`) with an empty cart. The bottom
"Cart" tab (`Cart-tab-item`) shows no item-count badge at this point.

Steps:
1. On the Products catalog screen, confirm the product grid is visible —
   each card is a `ProductItem` (e.g. "Sauce Labs Backpack - Black", "Sauce
   Labs Backpack - Green", "... - Orange", "... - Red").
2. Tap the first product card, "Sauce Labs Backpack - Black", to open its
   detail screen (resource-id `ProductDetails-screen`). Confirm the product
   name ("Sauce Labs Backpack - Black"), price ("$ 29.99"), and an
   "Add To Cart" button (resource-id `AddToCart`) are visible.
3. Tap the "Add To Cart" button (`AddToCart`).
4. Without navigating anywhere else, verify a cart item-count badge reading
   "1" appears immediately on the bottom "Cart" tab (scoped to the
   `Cart-tab-item` element — the numeral itself carries no distinct
   resource-id, so scope the assertion to be a child of `Cart-tab-item`
   rather than a bare text match).
5. Tap the "Catalog" tab (resource-id `Catalog-tab-item`) to return to the
   Products catalog screen. Confirm the Cart tab badge (scoped to
   `Cart-tab-item`) still reads "1".
6. Tap the "Cart" tab (`Cart-tab-item`) to open the cart (resource-id
   `Cart-screen`).

Expect: The Cart screen ("My Cart") shows the added product ("Sauce Labs
Backpack - Black") with quantity "1", the footer reads "Total: 1 Items"
alongside a matching price ("$29.99"), and the bottom "Cart" tab badge
(still scoped to `Cart-tab-item`) continues to read "1" — confirming the
item count/badge accurately reflects the single added product on both the
catalog screen and the cart screen.

Note for automation: prefer an id-scoped selector for the cart badge (e.g.
text "1" with `childOf: { id: "Cart-tab-item" }`) rather than a bare
`text: "1"` assertion. The raw view hierarchy always carries a stale/hidden
"empty cart" subtree (a11y text "No Items", "Oh no! Your cart is empty...")
underneath the active screen even after an item has been added, and other
"1"s appear elsewhere on screen (e.g. the quantity stepper on the product
detail and cart screens) — an unscoped match risks a false positive.
