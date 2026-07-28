# TC-91: Sort catalog by price in ascending order

<!-- source: qa-tool test case 91 | type: functional -->
<!-- automation rationale: Numeric price ordering is deterministic and can be asserted by scraping price values, parsing them to numbers, and verifying each is less than or equal to the next. -->
<!-- verified against real device (Android, com.saucelabs.mydemoapp.android): app launches directly onto the catalog/Products screen, no splash tap required. -->

## Scenario: TC-91 — Sort catalog by price in ascending order

Starting state: app freshly launched (launches directly onto the "Products" catalog screen).

Steps:
1. The catalog page is the initial "Products" screen shown on launch (`resource-id: com.saucelabs.mydemoapp.android:id/productTV`, text "Products", with catalog items listed in `com.saucelabs.mydemoapp.android:id/productRV`, each item's price in a `com.saucelabs.mydemoapp.android:id/priceTV` TextView, e.g. text "$ 29.99"). No extra navigation is needed.
2. Locate and tap the sort control in the top app bar: an icon button with `resource-id: com.saucelabs.mydemoapp.android:id/sortIV` (content-desc "Shows current sorting order and displays available sorting options"). Tapping it opens a "Sort by:" popup (`resource-id: com.saucelabs.mydemoapp.android:id/sortTV`, text "Sort by:") listing four options.
3. Select the ascending-by-price option, labeled "Price - Ascending" in the real UI (`resource-id: com.saucelabs.mydemoapp.android:id/priceAscCL`, content-desc "Ascending order by price", text "Price - Ascending").
4. Observe the order of items and their prices displayed in the catalog.

Expect: All catalog items are reordered from the lowest price to the highest price.

<!-- Confirmed on real device: with the default catalog state, selecting "Price - Ascending" produced strict low-to-high order, e.g. "Sauce Labs Onesie" $ 7.99, "Sauce Labs Bike Light" $ 9.99, "Sauce Labs Bolt T-Shirt" $ 15.99, "Test.allTheThings() T-Shirt" $ 15.99 (tie at $15.99 is valid ascending order), at the top of the list. The Expect outcome is genuinely true. -->
