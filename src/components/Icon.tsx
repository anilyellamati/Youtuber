// Inline stroke icons (no icon-font download, works offline).
const P: Record<string, string> = {
  record: "M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0",
  stop: "M7 7h10v10H7z",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l13 8-13 8z",
  flag: "M5 21V4h11l-2 4 2 4H5",
  scissors: "M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8.1 8.1L20 20M8.1 15.9L20 4",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  folder: "M3 6h6l2 2h10v11H3z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  camera: "M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  speaker: "M4 9h4l5-4v14l-5-4H4zM17 8a5 5 0 0 1 0 8M19.5 5.5a9 9 0 0 1 0 13",
  sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  youtube: "M2.5 7.5A3 3 0 0 1 5 5c2-.4 12-.4 14 0a3 3 0 0 1 2.5 2.5c.4 2.3.4 6.7 0 9A3 3 0 0 1 19 19c-2 .4-12 .4-14 0a3 3 0 0 1-2.5-2.5c-.4-2.3-.4-6.7 0-9zM10 9v6l5-3z",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
  plus: "M12 5v14M5 12h14",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8 11h6",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  volume: "M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 0 0-14.9-3.9L4 9M4 4v5h5M4 13a8 8 0 0 0 14.9 3.9L20 15M20 20v-5h-5",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  image: "M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 9a1.5 1.5 0 1 0 0-.01",
  wand: "M15 4V2M15 10V8M11 6H9M21 6h-2M18.4 2.6l-1.4 1.4M18.4 9.4L17 8M3 21l11-11M13 6l2 2",
  split: "M12 3v18M3 7l4 5-4 5M21 7l-4 5 4 5",
  hash: "M5 9h14M5 15h14M10 3L8 21M16 3l-2 18",
  library: "M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 15-4-1z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  chevronDown: "M6 9l6 6 6-6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.5",
};

export function Icon({ name, size = 18, fill = false, className }: { name: keyof typeof P | string; size?: number; fill?: boolean; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={fill ? 0 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={P[name] ?? P.info} />
    </svg>
  );
}
