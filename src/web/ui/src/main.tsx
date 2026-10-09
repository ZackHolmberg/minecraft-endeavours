import { render } from "preact";
import "./styles.css";
import { App } from "./App.js";
import { auth, refreshSession } from "./lib/api.js";
import { nudgeLive } from "./lib/ws.js";
import "./lib/status.js";

void refreshSession();

// Keep the session (and CSRF token) fresh: /me on focus and every 5 minutes.
let lastCheck = Date.now();
function check() {
  if (auth.get().status !== "authenticated") return;
  if (Date.now() - lastCheck < 30_000) return;
  lastCheck = Date.now();
  void refreshSession();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    check();
    nudgeLive();
  }
});
addEventListener("online", () => nudgeLive());
setInterval(() => {
  lastCheck = 0;
  check();
}, 5 * 60_000);

render(<App />, document.getElementById("app")!);
