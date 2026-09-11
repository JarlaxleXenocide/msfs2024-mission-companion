import type { AirportPosition } from '../shared/model';

/** Great-circle distance on a mean-radius Earth, in nautical miles. */
export function distanceNm(from: AirportPosition, to: AirportPosition): number | null {
  for (const point of [from, to]) {
    if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
        !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) return null;
  }
  const radians = Math.PI / 180;
  const a = Math.sin((to.latitude - from.latitude) * radians / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin((to.longitude - from.longitude) * radians / 2) ** 2;
  return 2 * (6371008.8 / 1852) * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
