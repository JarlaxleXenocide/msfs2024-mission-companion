import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceNm } from '../src/domain/distance';

test('great-circle distance handles same airport, dateline and opposite sides of Earth', () => {
  assert.equal(distanceNm({ latitude: 41, longitude: -86 }, { latitude: 41, longitude: -86 }), 0);
  assert.ok(Math.abs(distanceNm({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 })! - 120.081) < 0.01);
  assert.ok(Math.abs(distanceNm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })! - 10807.3) < 0.1);
  assert.equal(distanceNm({ latitude: NaN, longitude: 0 }, { latitude: 0, longitude: 0 }), null);
  assert.equal(distanceNm({ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 }), null);
  assert.equal(distanceNm({ latitude: 0, longitude: 181 }, { latitude: 0, longitude: 0 }), null);
});
