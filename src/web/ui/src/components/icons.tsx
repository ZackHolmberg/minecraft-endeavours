import type { SVGAttributes, VNode } from "preact";

/** Stroke icons (24px grid), drawn inline so no icon font / external asset is needed. */
type P = SVGAttributes<SVGSVGElement>;
const S = (d: VNode, p: P) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...p}>
    {d}
  </svg>
);

export const IHome = (p: P) => S(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>, p);
export const IBot = (p: P) => S(<><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4" /><circle cx="9" cy="13" r="1.3" fill="currentColor" /><circle cx="15" cy="13" r="1.3" fill="currentColor" /><path d="M9 17h6" /></>, p);
export const ITerminal = (p: P) => S(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>, p);
export const IUsers = (p: P) => S(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" /><path d="M18 14.8c2 .7 3.2 2.4 3.5 5.2" /></>, p);
export const IMore = (p: P) => S(<><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></>, p);
export const IJobs = (p: P) => S(<><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h7" /><circle cx="18" cy="16" r="3" /><path d="M18 14.6V16l1 .8" /></>, p);
export const ILogs = (p: P) => S(<><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 12h7M9 16h7" /></>, p);
export const IShield = (p: P) => S(<><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" /><path d="m9 12 2 2 4-4" /></>, p);
export const IArchive = (p: P) => S(<><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 13h4" /></>, p);
export const IServer = (p: P) => S(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>, p);
export const ICpu = (p: P) => S(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>, p);
export const IPlay = (p: P) => S(<path d="M7 4.5v15l12-7.5z" />, p);
export const IStop = (p: P) => S(<rect x="6" y="6" width="12" height="12" rx="2" />, p);
export const IRestart = (p: P) => S(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>, p);
export const ISave = (p: P) => S(<><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v5h7V3" /><rect x="8" y="13" width="8" height="5" /></>, p);
export const IAlert = (p: P) => S(<><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>, p);
export const IInfo = (p: P) => S(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>, p);
export const ICheck = (p: P) => S(<path d="m5 12.5 4.5 4.5L19 7.5" />, p);
export const IX = (p: P) => S(<path d="M6 6l12 12M18 6 6 18" />, p);
export const ILogout = (p: P) => S(<><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></>, p);
export const IPause = (p: P) => S(<><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>, p);
export const IDown = (p: P) => S(<><path d="M12 4v14" /><path d="m6 12 6 6 6-6" /></>, p);
export const ISend = (p: P) => S(<><path d="M4 12 20 4l-6 16-3-7z" /></>, p);
export const IPlus = (p: P) => S(<path d="M12 5v14M5 12h14" />, p);
export const ITrash = (p: P) => S(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>, p);
export const ICrown = (p: P) => S(<><path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z" /></>, p);
export const IMegaphone = (p: P) => S(<><path d="M3 10v4h4l8 5V5L7 10z" /><path d="M19 9a4 4 0 0 1 0 6" /></>, p);
export const IHeart = (p: P) => S(<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z" />, p);
export const IMap = (p: P) => S(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></>, p);
export const ISkull = (p: P) => S(<><path d="M5 11a7 7 0 1 1 14 0v4h-2v4H7v-4H5z" /><circle cx="9.5" cy="11.5" r="1.5" fill="currentColor" /><circle cx="14.5" cy="11.5" r="1.5" fill="currentColor" /></>, p);
export const IDoor = (p: P) => S(<><path d="M6 21V4h12v17" /><path d="M3 21h18" /><circle cx="14.5" cy="12.5" r="1" fill="currentColor" /></>, p);
export const IZap = (p: P) => S(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />, p);
export const IChat = (p: P) => S(<path d="M4 5h16v11H9l-5 4z" />, p);
export const IWifiOff = (p: P) => S(<><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M5 12.5a10 10 0 0 1 4-2.3M19 12.5a10 10 0 0 0-3-2" /><path d="M12 20h.01" /></>, p);
export const IClock = (p: P) => S(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, p);
export const IBox = (p: P) => S(<><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></>, p);
export const IPin = (p: P) => S(<><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></>, p);
export const IArrowLeft = (p: P) => S(<><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></>, p);
export const IKey = (p: P) => S(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" /></>, p);
export const IRefresh = (p: P) => S(<><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8" /><path d="M20 20v-4.5h-4.5" /></>, p);
