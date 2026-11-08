import type { CSSProperties } from "react";

export type IconName = "search" | "tram" | "bus" | "map" | "list" | "arrow" | "chevron" | "locate" | "star" | "clock" | "alert" | "info" | "close" | "pause" | "play" | "refresh" | "external" | "stats" | "check" | "signal" | "helicopter";

const paths: Record<IconName, string[]> = {
  search: ["M21 21l-4.5-4.5", "M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z"],
  tram: ["M6 18h12V7a3 3 0 0 0-3-3H9a3 3 0 0 0-3 3v11Z", "M6 10h12M9 4l1-2h4l1 2M9 21l-2-3m8 3 2-3M9 14h.01M15 14h.01"],
  bus: ["M5 17h14V6a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3v11Z", "M5 10h14M8 17v3m8-3v3M8 14h.01M16 14h.01M2 7v5m20-5v5"],
  map: ["m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z", "M9 3v16M15 5v16"],
  list: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
  arrow: ["m12 5-7 7 7 7M5 12h15"],
  chevron: ["m9 5 7 7-7 7"],
  locate: ["m21 3-7 18-3-8-8-3 18-7Z"],
  star: ["m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5l3 2"],
  alert: ["m12 3 10 18H2L12 3Z", "M12 9v5M12 17h.01"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 11v6M12 7h.01"],
  close: ["m6 6 12 12M6 18 18 6"],
  pause: ["M8 5v14M16 5v14"],
  play: ["m8 4 12 8-12 8V4Z"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M5.5 7a8 8 0 0 1 13-2l1.5 2M4 17l1.5 2a8 8 0 0 0 13-2"],
  external: ["M14 3h7v7M10 14 21 3", "M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"],
  stats: ["M4 20V10M12 20V4M20 20v-7"],
  check: ["m5 12 4 4L20 5"],
  signal: ["M5 20v-3M10 20v-7M15 20V8M20 20V3"],
  helicopter: ["M3 4h15M11 4v4M8 8h7a5 5 0 0 1 5 5v2H8a3 3 0 0 1-3-3V9L2 7v6h3M14 8v5h6M8 15v4m8-4v4M6 19h14"],
};

export function Icon({ name, size = 20, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name].map((d, index) => <path key={index} d={d} />)}</svg>;
}
