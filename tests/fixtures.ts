import type { Airport } from '../src/shared/model';

export const airport = (): Airport => ({
  position: null,
  key: 'A|||TEST',
  ident: 'TEST',
  icao: { type: 'A', region: '', airport: '', ident: 'TEST' },
  ends: [
    {
      id: '09',
      number: 9,
      designator: 0,
      physicalM: 1600,
      thresholdM: 0,
      thresholdElevationM: 0,
      physicalElevationM: 0,
      closed: false,
      ilsMHz: 110.3,
      glideslope: true,
    },
  ],
  procedures: [
    {
      name: 'ILS 09',
      type: 4,
      rnavFlags: 0,
      runwayNumber: 9,
      runwayDesignator: 0,
      rnpAr: false,
    },
  ],
});

// Minimal field extract from evidence/milestone-5/facilities.json (runways)
// and evidence/milestone-4/facilities.json (full procedures), recorded 2026-09-05.
// It contains simulator airport data only and intentionally omits the raw files.
export const recordedCyvr = {
  ident: 'CYVR',
  icaoStruct: { type: 'A', region: 'CY', airport: '', ident: 'CYVR' },
  loadedDataFlags: 73,
  runways: [
    {
      designation: '08L',
      direction: 8,
      runwayDesignator: 1,
      ilsFrequency: { freqMHz: 110.55000305175781, hasGlideslope: 1 },
      closed: false,
    },
    {
      designation: '08R',
      direction: 8,
      runwayDesignator: 2,
      ilsFrequency: { freqMHz: 109.5, hasGlideslope: 1 },
      closed: false,
    },
    {
      designation: '13',
      direction: 13,
      runwayDesignator: 0,
      ilsFrequency: { freqMHz: 111.0999984741211, hasGlideslope: 1 },
      closed: false,
    },
    {
      designation: '26L',
      direction: 26,
      runwayDesignator: 1,
      ilsFrequency: { freqMHz: 110.69999694824219, hasGlideslope: 1 },
      closed: false,
    },
    {
      designation: '26R',
      direction: 26,
      runwayDesignator: 2,
      ilsFrequency: { freqMHz: 111.94999694824219, hasGlideslope: 1 },
      closed: false,
    },
  ],
  rawRunways: [
    {
      designation: '31-13',
      length: 2285.225830078125,
      elevation: 2.497000217437744,
      designatorCharPrimary: 0,
      designatorCharSecondary: 0,
      primaryElevation: 3.0604352951049805,
      secondaryElevation: 1.9354910850524902,
      primaryThresholdLength: 0,
      secondaryThresholdLength: 0,
    },
    {
      designation: '26-8',
      length: 3032.429443359375,
      elevation: 2.497000217437744,
      designatorCharPrimary: 2,
      designatorCharSecondary: 1,
      primaryElevation: 2.0177290439605713,
      secondaryElevation: 3.0604352951049805,
      primaryThresholdLength: 221.68296813964844,
      secondaryThresholdLength: 0,
    },
    {
      designation: '26-8',
      length: 3714.50048828125,
      elevation: 2.497000217437744,
      designatorCharPrimary: 1,
      designatorCharSecondary: 2,
      primaryElevation: 3.0273542404174805,
      secondaryElevation: 2.0402207374572754,
      primaryThresholdLength: 210.30140686035156,
      secondaryThresholdLength: 211.48255920410156,
    },
  ],
  approaches: [
    {
      name: 'ILS 8R',
      approachType: 4,
      runwayNumber: 8,
      runwayDesignator: 2,
      rnavTypeFlags: 0,
      rnpAr: false,
    },
    {
      name: 'RNAV 8R X',
      approachType: 10,
      runwayNumber: 8,
      runwayDesignator: 2,
      rnavTypeFlags: 0,
      rnpAr: true,
    },
    {
      name: 'RNAV 8R Z',
      approachType: 10,
      runwayNumber: 8,
      runwayDesignator: 2,
      rnavTypeFlags: 27,
      rnpAr: false,
    },
    {
      name: 'RNAV 13',
      approachType: 10,
      runwayNumber: 13,
      runwayDesignator: 0,
      rnavTypeFlags: 11,
      rnpAr: false,
    },
  ],
};

// Minimal recorded MMQT/I73 procedure extracts from milestone 4, paired with
// the one-way and physical runway fields recorded in milestone 5.
export const recordedMmqt = {
  ident: 'MMQT',
  icaoStruct: { type: 'A', region: 'MM', airport: '', ident: 'MMQT' },
  loadedDataFlags: -1,
  runways: [
    {
      designation: '09',
      direction: 9,
      runwayDesignator: 0,
      ilsFrequency: null,
      closed: false,
    },
    {
      designation: '27',
      direction: 27,
      runwayDesignator: 0,
      ilsFrequency: null,
      closed: false,
    },
  ],
  rawRunways: [
    {
      designation: '9-27',
      length: 3486.2578125,
      elevation: 1909.214111328125,
      designatorCharPrimary: 0,
      designatorCharSecondary: 0,
      primaryElevation: 1900.375,
      secondaryElevation: 1918.0545654296875,
      primaryThresholdLength: 0,
      secondaryThresholdLength: 0,
    },
  ],
  approaches: [
    {
      name: 'VOR 9 Y',
      approachType: 8,
      runwayNumber: 9,
      runwayDesignator: 0,
      rnavTypeFlags: 0,
      rnpAr: false,
    },
    {
      name: 'VOR 27 Z',
      approachType: 8,
      runwayNumber: 27,
      runwayDesignator: 0,
      rnavTypeFlags: 0,
      rnpAr: false,
    },
  ],
};

export const recordedI73 = {
  ident: 'I73',
  icaoStruct: { type: 'A', region: 'K5', airport: '', ident: 'I73' },
  loadedDataFlags: 73,
  runways: [
    {
      designation: '08',
      direction: 8,
      runwayDesignator: 0,
      ilsFrequency: null,
      closed: false,
    },
  ],
  rawRunways: [
    {
      designation: '8-26',
      length: 1062.2822265625,
      elevation: 219.4560089111328,
      designatorCharPrimary: 0,
      designatorCharSecondary: 0,
      primaryElevation: 219.4560089111328,
      secondaryElevation: 219.4560089111328,
      primaryThresholdLength: 171.96926879882812,
      secondaryThresholdLength: 41.45280075073242,
    },
  ],
  approaches: [
    {
      name: 'RNAV A',
      approachType: 10,
      runwayNumber: 0,
      runwayDesignator: 0,
      rnavTypeFlags: 0,
      rnpAr: false,
    },
  ],
};

// Sanitized FacilityLoader getFacility(..., 73) positions observed 2026-09-06.
export const recordedPositions = [
  { ident: 'CYVR', icaoStruct: { type: 'A', region: 'CY', airport: '', ident: 'CYVR' }, loadedDataFlags: 73, lat: 49.194698333740234, lon: -123.18396759033203 },
  { ident: 'MMQT', icaoStruct: { type: 'A', region: 'MM', airport: '', ident: 'MMQT' }, loadedDataFlags: 73, lat: 20.61737823486328, lon: -100.1856918334961 },
];
