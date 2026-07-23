# TC-79: User login and logout (iOS)

<!-- source: qa-tool test case 79 | type: e2e -->

## Scenario: TC-79 — User login and logout (iOS)

Starting state: app freshly launched.

Steps:
1. Open the menu drawer from the catalog screen
2. Tap Login/Sign In
3. Enter valid demo credentials and submit
4. Confirm the logged-in state, then open the menu drawer and log out

Expect: Login succeeds with valid credentials and the app returns to a logged-out state after logout.
