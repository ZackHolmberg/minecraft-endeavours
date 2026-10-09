import type { ComponentChildren, FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { auth, logout } from "./lib/api.js";
import { useStore } from "./lib/store.js";
import { liveState } from "./lib/ws.js";
import { href, useRoute } from "./lib/router.js";
import { status } from "./lib/status.js";
import { ConfirmHost, ToastHost, confirm } from "./components/ui.js";
import { IArchive, IBot, IHome, IJobs, ILogout, ILogs, IMore, IShield, ITerminal, IUsers } from "./components/icons.js";
import { Login } from "./pages/Login.js";
import { Overview } from "./pages/Overview.js";
import { Jobs } from "./pages/Jobs.js";
import { Console } from "./pages/Console.js";
import { Players } from "./pages/Players.js";
import { Bot } from "./pages/Bot.js";
import { Logs } from "./pages/Logs.js";
import { Audit } from "./pages/Audit.js";
import { Backups } from "./pages/Backups.js";

interface NavItem {
  path: string;
  label: string;
  icon: FunctionComponent<{ width?: number }>;
  mobile: boolean; // in the bottom tab bar (others go in "More")
}
const NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: IHome, mobile: true },
  { path: "/bot", label: "Bot", icon: IBot, mobile: true },
  { path: "/console", label: "Console", icon: ITerminal, mobile: true },
  { path: "/players", label: "Players", icon: IUsers, mobile: true },
  { path: "/jobs", label: "Jobs", icon: IJobs, mobile: false },
  { path: "/logs", label: "Logs", icon: ILogs, mobile: false },
  { path: "/backups", label: "Backups", icon: IArchive, mobile: false },
  { path: "/audit", label: "Audit", icon: IShield, mobile: false },
];

function matches(route: string, path: string): boolean {
  return path === "/" ? route === "/" : route === path || route.startsWith(path + "/");
}

function LiveIndicator() {
  const s = useStore(liveState);
  const text = s === "live" ? "Live" : s === "connecting" ? "Connecting" : "Offline";
  return (
    <span class={`live ${s === "live" ? "on" : s === "connecting" ? "connecting" : "off"}`} role="status" aria-live="polite" title={s === "live" ? "Receiving live updates" : "Live updates disconnected — retrying"}>
      <span class="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

async function doLogout(all: boolean) {
  if (all) {
    const ok = await confirm({ title: "Sign out everywhere?", body: "Every session, on every device, will be signed out — including this one.", confirmLabel: "Sign out all", danger: true });
    if (!ok) return;
  }
  await logout(all);
}

function NavLinks({ route, items, onPick }: { route: string; items: NavItem[]; onPick?: () => void }) {
  return (
    <nav class="nav" aria-label="Main">
      {items.map((n) => (
        <a key={n.path} href={href(n.path)} aria-current={matches(route, n.path) ? "page" : undefined} onClick={onPick}>
          <n.icon />
          {n.label}
        </a>
      ))}
    </nav>
  );
}

function Shell({ route, title, children }: { route: string; title: string; children: ComponentChildren }) {
  const [more, setMore] = useState(false);
  const a = useStore(auth);
  const st = useStore(status);
  useEffect(() => setMore(false), [route]);
  useEffect(() => {
    document.title = `${title} · Server Panel`;
  }, [title]);
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMore(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [more]);
  const moreActive = NAV.some((n) => !n.mobile && matches(route, n.path));
  const user = a.status === "authenticated" ? a.me.user : "";
  return (
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="./favicon.svg" alt="" />
          <div>
            Server Panel
            <small>{st.data?.server.version ? `Paper ${st.data.server.version}` : "minecraft-with-friends"}</small>
          </div>
        </div>
        <NavLinks route={route} items={NAV} />
        <div class="sidebar-foot">
          <div class="small dim" style={{ padding: "0 10px" }}>
            Signed in as <strong>{user}</strong>
          </div>
          <button class="btn ghost sm" onClick={() => void doLogout(false)}>
            <ILogout /> Sign out
          </button>
          <button class="btn ghost sm" onClick={() => void doLogout(true)}>
            Sign out everywhere
          </button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1>{title}</h1>
          <LiveIndicator />
        </header>
        <main class="content" id="main">
          {children}
        </main>
      </div>
      <nav class="tabbar" aria-label="Main">
        {NAV.filter((n) => n.mobile).map((n) => (
          <a key={n.path} href={href(n.path)} aria-current={matches(route, n.path) ? "page" : undefined}>
            <n.icon />
            {n.label}
          </a>
        ))}
        <button aria-expanded={more} aria-haspopup="dialog" aria-current={moreActive ? "page" : undefined} onClick={() => setMore(!more)}>
          <IMore />
          More
        </button>
      </nav>
      {more && (
        <>
          <div class="scrim" onClick={() => setMore(false)} />
          <div class="sheet" role="dialog" aria-modal="true" aria-label="More pages">
            <div class="grabber" />
            <NavLinks route={route} items={NAV.filter((n) => !n.mobile)} onPick={() => setMore(false)} />
            <div class="divider" />
            <div class="small dim" style={{ padding: "8px 10px" }}>
              Signed in as <strong>{user}</strong>
            </div>
            <div class="row">
              <button class="btn grow" onClick={() => void doLogout(false)}>
                <ILogout /> Sign out
              </button>
              <button class="btn grow" onClick={() => void doLogout(true)}>
                Sign out all
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function App() {
  const a = useStore(auth);
  const route = useRoute();
  let page: ComponentChildren;
  let title = "Overview";
  if (a.status === "unknown") {
    return (
      <div class="login-page" aria-busy="true">
        <span class="spinner" aria-label="Loading" />
      </div>
    );
  }
  if (a.status === "anonymous") {
    return (
      <>
        <Login reason={a.reason} />
        <ToastHost />
      </>
    );
  }
  const jobMatch = /^\/jobs\/(.+)$/.exec(route);
  if (route === "/") page = <Overview />;
  else if (jobMatch) {
    title = "Job";
    page = <Jobs jobId={decodeURIComponent(jobMatch[1]!)} />;
  } else {
    const item = NAV.find((n) => matches(route, n.path));
    title = item?.label ?? "Not found";
    switch (item?.path) {
      case "/bot": page = <Bot tab={route.split("/")[2] ?? null} />; break;
      case "/console": page = <Console />; break;
      case "/players": page = <Players />; break;
      case "/jobs": page = <Jobs jobId={null} />; break;
      case "/logs": page = <Logs />; break;
      case "/backups": page = <Backups />; break;
      case "/audit": page = <Audit />; break;
      default: page = <div class="state"><strong>Page not found</strong><a href={href("/")}>Back to overview</a></div>;
    }
  }
  return (
    <>
      <Shell route={route} title={title}>{page}</Shell>
      <ConfirmHost />
      <ToastHost />
    </>
  );
}
