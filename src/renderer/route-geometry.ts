import type { AirportPosition } from '../shared/model';

export function routePoints(departure: AirportPosition | null, destination: AirportPosition | null): [number, number][] | null {
  if (!departure && !destination) return null;
  if (!departure) return [[destination!.latitude, destination!.longitude]];
  if (!destination) return [[departure.latitude, departure.longitude]];
  let longitude = destination.longitude;
  while (longitude - departure.longitude > 180) longitude -= 360;
  while (longitude - departure.longitude < -180) longitude += 360;
  return [[departure.latitude, departure.longitude], [destination.latitude, longitude]];
}
