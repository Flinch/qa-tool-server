# TC-90: Sort catalog by name in descending order

<!-- source: qa-tool test case 90 | type: functional -->
<!-- automation rationale: Reverse alphabetical ordering is deterministic and can be asserted programmatically by extracting item name text and comparing against a reverse-sorted array. -->

## Scenario: TC-90 — Sort catalog by name in descending order

Starting state: app freshly launched (catalog/Products screen is the initial screen).

Steps:
1. Navigate to the catalog page (this is the app's default landing screen)
2. Locate the sort control (the icon with accessible name "Shows current sorting order and displays available sorting options", resource-id `com.saucelabs.mydemoapp.android:id/sortIV`, in the header) and tap it to open the sort options menu
3. Select the 'Name - Descending' option from the sort menu (resource-id `com.saucelabs.mydemoapp.android:id/nameDesCL`, text "Name - Descending")
4. Observe the order of items displayed in the catalog

Expect: All catalog items are reordered alphabetically from Z to A by name
