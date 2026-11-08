import type { CSSProperties } from "react";

// Shared by the WebGL map and the line diagram, in CSS pixels.
export const VEHICLE_MARKER = { size: 24, radius: 6, selectedRadius: 7.5, stroke: 1.5, haloRadius: 10, arrow: "M12 8.5 14.5 14.5 12 13.3 9.5 14.5Z", stale: "#8793a2" } as const;

export function vehicleBearing(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 360 ? value % 360 : null;
}

export default function TransitVehicleMarker({ color, textColor = "#ffffff", bearing, stationary = false, fresh = true, attentionColor, selected = false, style }: {
  color: string; textColor?: string; bearing?: number | null; stationary?: boolean; fresh?: boolean; attentionColor?: string; selected?: boolean; style?: CSSProperties;
}) {
  const angle = vehicleBearing(bearing);
  return <svg width={VEHICLE_MARKER.size} height={VEHICLE_MARKER.size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0, ...style }}>
    {attentionColor && fresh ? <circle cx="12" cy="12" r={VEHICLE_MARKER.haloRadius} fill={attentionColor} fillOpacity=".2" stroke={attentionColor} strokeWidth="1.5" /> : null}
    <g opacity={fresh ? 1 : .7}>
      <circle cx="12" cy="12" r={selected ? VEHICLE_MARKER.selectedRadius : VEHICLE_MARKER.radius} fill={fresh ? color : VEHICLE_MARKER.stale} stroke="#fff" strokeWidth={VEHICLE_MARKER.stroke} />
      {stationary || angle === null ? <circle cx="12" cy="12" r="1.4" fill={textColor} /> : <path d={VEHICLE_MARKER.arrow} fill={textColor} transform={`rotate(${angle} 12 12)`} />}
    </g>
  </svg>;
}
