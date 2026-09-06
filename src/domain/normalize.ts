import type {
  Airport,
  Icao,
  Mission,
  Procedure,
  RunwayEnd,
} from '../shared/model';

const REQUIRED_FACILITY_FLAGS = 73;

export function normalizeMission(input: unknown): Mission {
  const value = expectObject(input, 'mission');
  const specialization = expectObject(value.specialization, 'mission.specialization');
  const departure = expectObject(value.departure, 'mission.departure');
  const arrival = expectObject(value.arrival, 'mission.arrival');

  return {
    guid: expectNonemptyString(value.missionGUID, 'mission.missionGUID'),
    title: expectNonemptyString(value.title, 'mission.title'),
    activity: expectNonemptyString(
      specialization.valueStr,
      'mission.specialization.valueStr',
    ),
    departure: expectNonemptyString(departure.iCAO, 'mission.departure.iCAO'),
    destination: expectNonemptyString(arrival.iCAO, 'mission.arrival.iCAO'),
    payoutText: dataValueText(value.money, true),
    payoutCredits: nonnegativeNumber(
      optionalObject(value.money)?.value,
    ),
    durationText: dataValueText(value.duration, false),
  };
}

export function normalizeAirport(input: unknown): Airport {
  const value = expectObject(input, 'airport');
  const ident = expectNonemptyString(value.ident, 'airport.ident');
  const icao = normalizeIcao(value.icaoStruct);
  if (icao.ident !== ident) {
    throw new TypeError('airport ident must match structured ICAO ident');
  }

  const flags = expectInteger(value.loadedDataFlags, 'airport.loadedDataFlags');
  if ((flags & REQUIRED_FACILITY_FLAGS) !== REQUIRED_FACILITY_FLAGS) {
    throw new TypeError('required facility data flags are missing');
  }

  const rawRunways = optionalArray(value.rawRunways, 'airport.rawRunways');
  const runways = optionalArray(value.runways, 'airport.runways');
  const approaches = optionalArray(value.approaches, 'airport.approaches');
  const physicalEnds = rawRunways?.flatMap(normalizePhysicalRunway) ?? [];

  const latitude = finiteNumber(value.lat);
  const longitude = finiteNumber(value.lon);
  return {
    position: latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ? { latitude, longitude } : null,
    key: [icao.type, icao.region, icao.airport, icao.ident].join('|'),
    ident,
    icao,
    ends: runways?.map((runway) => normalizeRunwayEnd(runway, physicalEnds)) ?? null,
    procedures: approaches?.map(normalizeProcedure) ?? null,
  };
}

interface PhysicalEnd {
  number: number;
  designator: number;
  physicalM: number | null;
  thresholdM: number | null;
  thresholdElevationM: number | null;
  physicalElevationM: number | null;
}

function normalizeIcao(input: unknown): Icao {
  const value = expectObject(input, 'airport.icaoStruct');
  return {
    type: expectNonemptyString(value.type, 'airport.icaoStruct.type'),
    region: expectString(value.region, 'airport.icaoStruct.region'),
    airport: expectString(value.airport, 'airport.icaoStruct.airport'),
    ident: expectNonemptyString(value.ident, 'airport.icaoStruct.ident'),
  };
}

function normalizePhysicalRunway(input: unknown): PhysicalEnd[] {
  const value = expectObject(input, 'physical runway');
  const designation = expectNonemptyString(
    value.designation,
    'physical runway.designation',
  );
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(designation);
  if (!match) throw new TypeError('physical runway designation is invalid');

  const physicalM = finiteNumber(value.length);
  const physicalElevationM = finiteNumber(value.elevation);
  return [
    {
      number: Number(match[1]),
      designator: expectInteger(
        value.designatorCharPrimary,
        'physical runway.designatorCharPrimary',
      ),
      physicalM,
      thresholdM: finiteNumber(value.primaryThresholdLength),
      thresholdElevationM: finiteNumber(value.primaryElevation),
      physicalElevationM,
    },
    {
      number: Number(match[2]),
      designator: expectInteger(
        value.designatorCharSecondary,
        'physical runway.designatorCharSecondary',
      ),
      physicalM,
      thresholdM: finiteNumber(value.secondaryThresholdLength),
      thresholdElevationM: finiteNumber(value.secondaryElevation),
      physicalElevationM,
    },
  ];
}

function normalizeRunwayEnd(
  input: unknown,
  physicalEnds: PhysicalEnd[],
): RunwayEnd {
  const value = expectObject(input, 'runway end');
  const number = expectInteger(value.direction, 'runway end.direction');
  const designator = expectInteger(
    value.runwayDesignator,
    'runway end.runwayDesignator',
  );
  const matches = physicalEnds.filter(
    (end) => end.number === number && end.designator === designator,
  );
  if (matches.length > 1) {
    throw new TypeError('physical runway end identity is ambiguous');
  }
  const physical = matches[0];
  const ils = optionalObject(value.ilsFrequency);

  return {
    id: expectNonemptyString(value.designation, 'runway end.designation'),
    number,
    designator,
    physicalM: physical?.physicalM ?? null,
    thresholdM: physical?.thresholdM ?? null,
    thresholdElevationM: physical?.thresholdElevationM ?? null,
    physicalElevationM: physical?.physicalElevationM ?? null,
    closed: optionalBoolean(value.closed),
    ilsMHz: finiteNumber(ils?.freqMHz),
    glideslope: optionalBooleanFlag(ils?.hasGlideslope),
  };
}

function normalizeProcedure(input: unknown): Procedure {
  const value = expectObject(input, 'approach');
  return {
    name: expectNonemptyString(value.name, 'approach.name'),
    type: expectInteger(value.approachType, 'approach.approachType'),
    rnavFlags: optionalInteger(value.rnavTypeFlags),
    runwayNumber: optionalInteger(value.runwayNumber),
    runwayDesignator: optionalInteger(value.runwayDesignator),
    rnpAr: optionalBoolean(value.rnpAr),
  };
}

function dataValueText(input: unknown, includeUnit: boolean): string | null {
  const value = optionalObject(input);
  if (
    !value ||
    typeof value.valueStr !== 'string' ||
    value.valueStr.trim().length === 0
  ) {
    return null;
  }
  if (includeUnit) {
    if (typeof value.unit !== 'string' || value.unit.trim().length === 0) return null;
    return `${value.valueStr} ${value.unit}`;
  }
  return value.valueStr;
}

function expectObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown, name: string): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  return value;
}

function expectNonemptyString(value: unknown, name: string): string {
  const result = expectString(value, name);
  if (result.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return result;
}

function expectInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonnegativeNumber(value: unknown): number | null {
  const result = finiteNumber(value);
  return result !== null && result >= 0 ? result : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function optionalBooleanFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}
