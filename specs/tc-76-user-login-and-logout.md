# TC-76: User login and logout

<!-- source: qa-tool test case 76 | type: e2e -->

## Scenario: TC-76 — User login and logout

Starting state: app freshly launched.

Steps:
1. Open the menu drawer from the catalog screen by tapping the hamburger icon in the header (`a11y: "View menu"`, `resource-id: menuIV`). This opens the drawer (`resource-id: drawerMenu`) listing menu items including "Catalog", "WebView", and, at the bottom, an auth toggle item that reads "Log In" (`a11y: "Login Menu Item"`) when logged out.
2. Tap the "Log In" menu item to open the Login screen.
3. On the Login screen, enter valid demo credentials into the username field (`resource-id: nameET`) and password field (`resource-id: passwordET`), then tap the "Login" button (`resource-id: loginBtn`, `a11y: "Tap to login with given credentials"`). The screen also lists tappable demo credentials that auto-populate both fields; the first entry's on-screen text is `bod@example.com` with password `10203040` (confirmed verbatim from the app UI — note it is "bod@", not "bob@").
4. Confirm the logged-in state: the app returns to the Products catalog screen, and re-opening the menu drawer shows the auth toggle item now reads "Log Out" (`a11y: "Logout Menu Item"`) instead of "Log In". Tap "Log Out".
5. A native confirmation dialog appears ("Are you sure you want to logout") with CANCEL (`android:id/button2`) and LOGOUT (`android:id/button1`) buttons. Tap LOGOUT to confirm.

Expect: Login succeeds with valid credentials — the app returns to the Products catalog and the drawer's auth menu item flips to "Log Out". After confirming the logout dialog, the app navigates to the Login screen (not merely back to the catalog with the item reverted to "Log In"), confirming a logged-out state.
