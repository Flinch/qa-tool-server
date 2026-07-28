# TC-89: Sort catalog by name in ascending order

<!-- source: qa-tool test case 89 | type: functional -->
<!-- automation rationale: Alphabetical ordering is deterministic and can be asserted programmatically by extracting item name text and comparing against a sorted array. -->
<!-- verified against real device (Android, com.saucelabs.mydemoapp.android): app launches directly onto the catalog/Products screen, no splash tap required. -->

## Scenario: TC-89 — Sort catalog by name in ascending order

Starting state: app freshly launched (launches directly onto the "Products" catalog screen).

Steps:
1. The catalog page is the initial "Products" screen shown on launch (`resource-id: com.saucelabs.mydemoapp.android:id/productTV`, text "Products", with catalog items listed in `com.saucelabs.mydemoapp.android:id/productRV`). No extra navigation is needed.
2. Locate and tap the sort control in the top app bar: an icon button with `resource-id: com.saucelabs.mydemoapp.android:id/sortIV` (content-desc "Shows current sorting order and displays available sorting options"). Tapping it opens a "Sort by:" popup (`resource-id: com.saucelabs.mydemoapp.android:id/sortTV`, text "Sort by:") listing four options.
3. Select the ascending-by-name option, labeled "Name - Ascending" in the real UI (`resource-id: com.saucelabs.mydemoapp.android:id/nameAscCL`, content-desc "Ascending order by name", text "Name - Ascending").
4. Observe the order of items displayed in the catalog.

Expect: All catalog items are reordered alphabetically from A to Z by name.

<!-- Confirmed on real device: with the default catalog state, choosing "Descending order by name" first produced the reverse order (e.g. "Test.allTheThings() T-Shirt (yellow/turquoise/purple/pink)" at the top, Z→A), and re-selecting "Name - Ascending" restored strict A→Z order (e.g. "Sauce Labs Backpack", "Sauce Labs Backpack (green)", "Sauce Labs Backpack (orange)", "Sauce Labs Backpack (red)" at the top). The Expect outcome is genuinely true. -->
