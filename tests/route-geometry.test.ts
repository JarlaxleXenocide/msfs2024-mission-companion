import assert from 'node:assert/strict';
import test from 'node:test';
import { routePoints } from '../src/renderer/route-geometry';

test('route points use the shortest longitude span without mutating endpoints', () => {
  const cases = [
    [{ latitude: 10, longitude: 179 }, { latitude: 11, longitude: -179 }, 2],
    [{ latitude: 10, longitude: -179 }, { latitude: 11, longitude: 179 }, -2],
    [{ latitude: 89, longitude: 170 }, { latitude: 89, longitude: -170 }, 20],
    [{ latitude: 0, longitude: 20 }, { latitude: 0, longitude: 20 }, 0],
  ] as const;
  for (const [departure, destination, difference] of cases) {
    const original = structuredClone(destination);
    const points = routePoints(departure, destination);
    assert.equal(points![1][1] - points![0][1], difference);
    assert.deepEqual(destination, original);
  }
  assert.equal(routePoints(null, null), null);
  assert.deepEqual(routePoints({ latitude: 4, longitude: 5 }, null), [[4, 5]]);
});
