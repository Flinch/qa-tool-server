# TC-79: User login and logout (iOS)

<!-- source: qa-tool test case 79 | type: e2e -->

## Scenario: TC-79 — User login and logout (iOS)

Starting state: app freshly launched (Catalog screen showing).

Steps:
1. From the Catalog screen, tap the "More" tab in the bottom navigation bar (`More-tab-item`) to open the More menu screen. This is a scrollable list of items ending in a "Login" row (`LogOut-menu-item`) — it is a full screen reached via the bottom tab bar, not a swipe-out drawer.
2. Tap the "Login" row (the last item in the More list) to navigate to the Login screen. Note: the row's accessibility text is empty pre-login (confirmed via `inspect_screen`) even though "Login" is visibly rendered — a text-based tap (`tapOn: "Login"`) fails outright with element-not-found. Tap by `id: LogOut-menu-item` instead (same id is used both pre- and post-login).
3. On the Login screen, enter valid demo credentials and submit:
   - The screen lists demo accounts under "Select a username from the list below": `bob@example.com`, `alice@example.com`, `john@example.com`, `visual@example.com`, all sharing the password `10203040`.
   - Tap one of the listed usernames (e.g. `bob@example.com`) to auto-fill both the "User Name" and "Password" fields, or type the username and `10203040` manually into the respective fields.
   - Tap the green "Login" button to submit.
4. Confirm the logged-in state: the app redirects to the Catalog screen automatically. Tap the "More" tab again and confirm the last menu row now reads "Log Out" instead of "Login" — this is the logged-in indicator. Tap "Log Out" (`LogOut-menu-item`) to log out.

Expect: Login succeeds with valid credentials (any listed demo username + password `10203040`) and redirects to the Catalog screen; the More menu's last row changes from "Login" to "Log Out" while logged in. Tapping "Log Out" immediately navigates to the Login screen, confirming the app has returned to a logged-out state.
