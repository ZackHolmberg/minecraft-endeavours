import { useEffect, useState } from "preact/hooks";

/** Hash routing: the panel server only needs to serve index.html at "/". */
export function currentPath(): string {
  const h = location.hash.replace(/^#/, "").replace(/[?].*$/, "");
  return h.startsWith("/") ? h : "/";
}

export function useRoute(): string {
  const [p, setP] = useState(currentPath());
  useEffect(() => {
    const on = () => setP(currentPath());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return p;
}

export function navigate(path: string): void {
  location.hash = path;
}

export function href(path: string): string {
  return `#${path}`;
}
