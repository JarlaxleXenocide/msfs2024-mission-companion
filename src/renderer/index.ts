import type {
  AppState,
  Category,
  Preferences,
  Procedure,
  Row,
  RunwayEnd,
} from '../shared/model';
import { groupRunways } from '../domain/classify';
import stylesURL from './styles.css';
import { RouteMapController } from './route-map';
import {
  displayElevation,
  displayLength,
  matchingRunwayLength,
  missionSummary,
  parseMinimumFt,
  rowCounts,
  visibleRows,
  type RowSort,
  cycleSort,
  type SortCriterion,
} from './view-model';

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = stylesURL;
document.head.append(stylesheet);

const app = required<HTMLElement>('app');
const connection = required<HTMLElement>('connection-label').parentElement!.parentElement!;
const connectionLabel = required<HTMLElement>('connection-label');
const observedAt = required<HTMLElement>('observed-at');
const connectionMessage = required<HTMLElement>('connection-message');
const warning = required<HTMLElement>('preference-warning');
const desktopHelp = required<HTMLElement>('desktop-help');
const minimizeHelp = required<HTMLElement>('minimize-help');
const pinControl = required<HTMLElement>('pin-control');
const settingsSummary = required<HTMLElement>('settings-summary');
const tbody = required<HTMLTableSectionElement>('mission-rows');
const routeMap = new RouteMapController(tbody, guid => window.companion.selectRoute(guid),
  key => { void window.companion.openAttribution(key).catch(error => console.error('Attribution link could not open:', error)); });
const counts = required<HTMLElement>('counts');
const theme = required<HTMLSelectElement>('theme');
const appearance = required<HTMLSelectElement>('appearance');
const compact = required<HTMLInputElement>('compact');
const keepOnTop = required<HTMLInputElement>('keep-on-top');
const port = required<HTMLInputElement>('port');
const portError = required<HTMLElement>('port-error');
const minimum = required<HTMLInputElement>('minimum');
const minimumError = required<HTMLElement>('minimum-error');
const matchesOnly = required<HTMLInputElement>('matches-only');
const search = required<HTMLInputElement>('search');
const sortControls = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sort]'));
const categoryControls = Array.from(document.querySelectorAll<HTMLInputElement>('[data-category]'));
const systemMode = matchMedia('(prefers-color-scheme: dark)');
const expanded = new Set<string>();

let preferences: Preferences | null = null;
let state: AppState | null = null;
let selectedGuid: string | null = null;
let sorts: SortCriterion[] = [];
let saveVersion = 0;
let tableSignature = '';

const unsubscribe = window.companion.subscribe(acceptState);
addEventListener('unload', () => { routeMap.dispose(); unsubscribe(); }, { once: true });
systemMode.addEventListener('change', () => applyTheme());

for (const control of categoryControls) control.addEventListener('change', () => {
  if (!preferences) return;
  const categories = categoryControls
    .filter(input => input.checked)
    .map(input => input.dataset.category as Category);
  void savePreferences({ ...preferences, criteria: { ...preferences.criteria, categories } });
});

minimum.addEventListener('change', () => {
  if (!preferences) return;
  const parsed = parseMinimumFt(minimum.value.trim(), minimum.validity.badInput);
  if (!parsed.valid) {
    minimumError.textContent = 'Enter zero or a positive runway length, or leave blank.';
    minimum.setAttribute('aria-invalid', 'true');
    return;
  }
  minimumError.textContent = '';
  minimum.removeAttribute('aria-invalid');
  void savePreferences({ ...preferences, criteria: { ...preferences.criteria, minimumFt: parsed.value } });
});

minimum.addEventListener('input', () => {
  if (parseMinimumFt(minimum.value.trim(), minimum.validity.badInput).valid) {
    minimumError.textContent = '';
    minimum.removeAttribute('aria-invalid');
  }
});

matchesOnly.addEventListener('change', () => {
  if (preferences) void savePreferences({ ...preferences, matchesOnly: matchesOnly.checked });
});
compact.addEventListener('change', () => {
  if (!preferences) return;
  preferences = { ...preferences, compact: compact.checked };
  applyTheme();
  renderTable(true);
  void savePreferences(preferences);
});
theme.addEventListener('change', () => {
  if (!preferences) return;
  preferences = { ...preferences, theme: theme.value as Preferences['theme'] };
  applyTheme();
  void savePreferences(preferences);
});
appearance.addEventListener('change', () => {
  if (!preferences) return;
  preferences = { ...preferences, appearance: appearance.value as Preferences['appearance'] };
  applyTheme();
  void savePreferences(preferences);
});
keepOnTop.addEventListener('change', () => {
  if (preferences) void savePreferences({ ...preferences, keepOnTop: keepOnTop.checked });
});
port.addEventListener('change', () => {
  if (!preferences) return;
  const value = Number(port.value);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    portError.textContent = 'Enter a local port from 1 through 65535.';
    port.setAttribute('aria-invalid', 'true');
    return;
  }
  portError.textContent = '';
  port.removeAttribute('aria-invalid');
  void savePreferences({ ...preferences, port: value });
});
search.addEventListener('input', () => renderTable(true));
for (const button of sortControls) {
  const label = button.textContent!;
  button.dataset.label = label;
  button.ariaLabel = `${label}: off. Sort descending`;
  button.addEventListener('click', () => {
    sorts = cycleSort(sorts, button.dataset.sort as RowSort);
    for (const control of sortControls) {
      const index = sorts.findIndex(sort => sort.column === control.dataset.sort);
      const active = sorts[index];
      const name = control.dataset.label!;
      control.textContent = active ? `${name} ${active.direction === 'desc' ? '↓' : '↑'} ${index + 1}` : name;
      control.ariaLabel = active
        ? `${name}: ${active.direction === 'desc' ? 'descending' : 'ascending'}, priority ${index + 1}. ${active.direction === 'desc' ? 'Sort ascending' : 'Turn sorting off'}`
        : `${name}: off. Sort descending`;
      if (index === 0) control.parentElement!.setAttribute('aria-sort', active.direction === 'desc' ? 'descending' : 'ascending');
      else control.parentElement!.removeAttribute('aria-sort');
    }
    renderTable(true);
  });
}

bindAction('refresh', () => window.companion.refresh());
bindAction('retry', () => window.companion.retry());
bindAction('refresh-airports', () => window.companion.refreshAirports());

void Promise.all([window.companion.getPreferences(), window.companion.getState()])
  .then(([initialPreferences, initialState]) => {
    preferences = initialPreferences;
    syncPreferenceControls();
    applyTheme();
    acceptState(state ?? initialState);
    app.ariaBusy = 'false';
  })
  .catch(error => {
    connectionLabel.textContent = 'Interface unavailable';
    connectionMessage.textContent = error instanceof Error ? error.message : 'The companion interface could not start.';
    connection.dataset.state = 'unavailable';
    app.ariaBusy = 'false';
  });

function acceptState(next: AppState): void {
  state = next;
  const current = new Set(next.rows.map(row => row.mission.guid));
  for (const guid of expanded) if (!current.has(guid)) expanded.delete(guid);
  if (selectedGuid !== null && !current.has(selectedGuid)) selectedGuid = null;
  renderState();
}

function renderState(): void {
  if (!state) return;
  const labels: Record<AppState['connection'], string> = {
    connecting: 'Connecting', unavailable: 'Simulator unavailable',
    'views-unavailable': 'Required simulator views unavailable', inactive: 'Career missions inactive',
    briefing: 'Briefing open', updating: 'Mission list updating', ready: 'Connected',
    unsupported: 'Unsupported simulator screen', stalled: 'Native request stalled',
  };
  connection.dataset.state = state.connection;
  app.dataset.connection = state.connection;
  app.dataset.stale = String(state.stale);
  connectionLabel.textContent = state.connection === 'updating' ? 'Connected · updating'
    : state.stale ? `${labels[state.connection]} · stale` : labels[state.connection];
  connectionLabel.title = connectionLabel.textContent;
  observedAt.textContent = state.observedAt ? `Observed ${formatTime(state.observedAt)}` : 'No mission snapshot yet';
  connectionMessage.textContent = state.message || setupMessage(state.connection);

  warning.hidden = !state.desktop?.preferenceWarning;
  warning.textContent = state.desktop?.preferenceWarning ?? '';
  const managed = state.desktop?.keepOnTop === 'desktop-managed';
  pinControl.hidden = managed;
  desktopHelp.hidden = !managed;
  desktopHelp.textContent = managed ? state.desktop?.keepOnTopHelp ?? '' : '';
  minimizeHelp.hidden = state.desktop?.minimizePolling !== 'desktop-limited';

  const aggregate = rowCounts(state.rows);
  const prefix = state.stale || state.connection !== 'ready' ? 'Last known results' : 'Current results';
  counts.textContent = `${prefix} · ${aggregate.match} match · ${aggregate.noMatch} not matching · ${aggregate.pending} pending · ${aggregate.unknown} unknown`;
  renderTable();
  routeMap.update(state);
}

function renderTable(force = false): void {
  if (!state || !preferences) return;
  const signature = JSON.stringify([state.rows, state.rows.length ? null : [state.connection, state.stale], search.value, preferences.matchesOnly, sorts, preferences.compact, [...expanded], selectedGuid]);
  if (!force && signature === tableSignature) return;
  tableSignature = signature;
  const rows = visibleRows(state.rows, search.value, preferences.matchesOnly, sorts);
  const missionRows = new Map(Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr.mission-row[data-guid]'))
    .map(row => [row.dataset.guid!, row]));
  const detailRows = new Map(Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr.details-row[data-detail-guid]'))
    .map(row => [row.dataset.detailGuid!, row]));
  const desired: HTMLTableRowElement[] = [];
  if (rows.length === 0) {
    const row = element('tr', 'empty-row');
    const empty = element('td', '', state.rows.length ? 'No missions match the current view.'
      : state.connection === 'ready' && !state.stale ? 'The current Career list is empty.'
      : 'No current mission list is available. Check simulator status above.');
    empty.colSpan = 6;
    row.append(empty);
    desired.push(row);
  } else {
    for (const row of rows) {
      const guid = row.mission.guid;
      const missionRow = missionRows.get(guid) ?? createMissionRow();
      updateMissionRow(missionRow, row);
      desired.push(missionRow);
      if (expanded.has(guid)) {
        const nextDetail = detailRow(row);
        const detail = detailRows.get(guid);
        if (detail) {
          detail.id = nextDetail.id;
          detail.replaceChildren(...Array.from(nextDetail.childNodes));
          desired.push(detail);
        } else {
          desired.push(nextDetail);
        }
      }
    }
  }

  for (const [index, row] of desired.entries()) {
    const current = tbody.children.item(index);
    if (current !== row) tbody.insertBefore(row, current);
  }
  while (tbody.children.length > desired.length) tbody.lastElementChild!.remove();
  routeMap.update(state);
}

function createMissionRow(): HTMLTableRowElement {
  const missionRow = element('tr', 'mission-row');
  const toggleCell = element('td');
  const toggle = element('button', 'expand');
  toggle.type = 'button';
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    const guid = toggle.dataset.guid;
    if (!guid) return;
    if (expanded.has(guid)) expanded.delete(guid); else expanded.add(guid);
    selectedGuid = guid;
    renderTable(true);
  });
  toggleCell.append(toggle);
  missionRow.append(...Array.from({ length: 5 }, () => element('td')), toggleCell);
  missionRow.addEventListener('click', () => {
    const guid = missionRow.dataset.guid;
    if (!guid) return;
    selectedGuid = guid;
    renderTable(true);
  });
  return missionRow;
}

function updateMissionRow(missionRow: HTMLTableRowElement, row: Row): void {
  const guid = row.mission.guid;
  const isExpanded = expanded.has(guid);
  missionRow.classList.toggle('selected', selectedGuid === guid || isExpanded);
  missionRow.dataset.guid = guid;
  const toggle = missionRow.cells[5].querySelector<HTMLButtonElement>('button')!;
  toggle.textContent = isExpanded ? 'Hide runways −' : 'Show runways +';
  toggle.dataset.guid = guid;
  toggle.setAttribute('aria-expanded', String(isExpanded));
  toggle.setAttribute('aria-controls', detailId(guid));
  toggle.setAttribute('aria-label', `${isExpanded ? 'Hide' : 'Show'} runway details for ${row.mission.title}`);
  const summary = missionSummary(row.mission, preferences!.compact);
  missionRow.cells[0].replaceChildren(
    element('div', 'mission-title', row.mission.title),
    element('div', 'secondary', row.mission.activity),
  );
  missionRow.cells[1].replaceChildren(
    routeButton(row.mission),
  );
  missionRow.cells[2].textContent = summary.duration;
  missionRow.cells[3].textContent = summary.payout;
  const categories = categoryCell(row);
  missionRow.cells[4].className = categories.className;
  missionRow.cells[4].replaceChildren(...Array.from(categories.childNodes));
  missionRow.cells[5].replaceChildren(
    toggle,
    element('div', '', runwaySummary(row)),
    element('div', 'secondary', runwayGeometry(row)),
    statusLabel(row),
  );
}

function routeButton(mission: Row['mission']): HTMLButtonElement {
  const button = element('button', 'route-trigger');
  button.type = 'button';
  button.dataset.routeGuid = mission.guid;
  button.setAttribute('aria-label', `Preview route from ${mission.departure} to ${mission.destination}`);
  button.setAttribute('aria-controls', 'route-map-popup');
  button.setAttribute('aria-expanded', 'false');
  button.append(element('span', 'route-code', mission.departure), document.createTextNode(' → '), element('strong', 'route-code', mission.destination));
  return button;
}

function detailRow(row: Row): HTMLTableRowElement {
  const detail = element('tr', 'details-row');
  detail.id = detailId(row.mission.guid);
  detail.dataset.detailGuid = row.mission.guid;
  const container = element('td');
  container.colSpan = 6;
  const heading = element('div', 'detail-heading');
  heading.append(
    element('strong', '', `${row.mission.destination} · Approaches by runway end`),
    element('span', '', row.facility.status === 'ready' ? `${groupRunways(row.facility.airport).length} groups` : 'Facility details unavailable'),
  );
  container.append(heading);

  if (row.facility.status === 'ready') {
    const groups = groupRunways(row.facility.airport);
    const grid = element('div', 'detail-grid');
    for (const group of groups) grid.append(runwayCard(group.end, group.procedures));
    if (groups.length) container.append(grid);
    if (row.facility.airport.ends === null) container.append(element('p', 'detail-note', 'Runway data is unavailable.'));
    if (row.facility.airport.procedures === null) container.append(element('p', 'detail-note', 'Approach data is unavailable.'));
  } else {
    container.append(element('p', 'detail-note', row.facility.status === 'pending' ? 'Airport data is still loading.' : row.facility.reason));
  }
  for (const reason of row.decision?.reasons ?? []) container.append(element('p', 'detail-note', reason));
  detail.append(container);
  return detail;
}

function runwayCard(end: RunwayEnd | null, procedures: Procedure[]): HTMLElement {
  const card = element('section', 'runway-card');
  const head = element('div', 'runway-head');
  head.append(
    element('h3', 'runway-id', end?.id ?? 'No specific runway'),
    element('span', '', end ? `Threshold elevation · ${displayElevation(end.thresholdElevationM)}` : 'Circling or unassociated procedures'),
  );
  card.append(head);
  if (end) {
    const landingM = end.physicalM !== null && end.thresholdM !== null &&
      Number.isFinite(end.physicalM) && Number.isFinite(end.thresholdM) &&
      end.physicalM >= end.thresholdM && end.thresholdM >= 0
      ? end.physicalM - end.thresholdM : null;
    const metrics = element('div', 'metrics');
    metrics.append(
      metric('Physical length', displayLength(end.physicalM)),
      metric('Threshold displacement', displayLength(end.thresholdM)),
      metric('Threshold-adjusted length', displayLength(landingM)),
      metric('Physical elevation', displayElevation(end.physicalElevationM)),
      metric('Closure', end.closed === false ? 'Open' : end.closed === true ? 'Closed' : 'Unknown'),
    );
    card.append(metrics);
  }
  if (!procedures.length) card.append(element('p', 'detail-note', 'No associated procedures are available.'));
  for (const procedure of procedures) {
    const item = element('div', 'procedure');
    item.append(
      element('strong', '', procedure.name),
      element('span', '', `${procedureType(procedure)} · RNP-AR: ${procedure.rnpAr === null ? 'Unknown' : procedure.rnpAr ? 'Yes' : 'No'}`),
    );
    card.append(item);
  }
  return card;
}

function categoryCell(row: Row): HTMLTableCellElement {
  const td = element('td');
  const categories = availableCategories(row);
  if (!categories.length) {
    const confirmedEmpty = row.facility.status === 'ready' && row.facility.airport.procedures !== null;
    td.append(element('span', 'secondary', confirmedEmpty ? 'None found' : 'Unknown'));
    return td;
  }
  const badges = element('div', 'badges');
  for (const category of categories) badges.append(element('span', 'badge', category));
  td.append(badges);
  return td;
}

function statusLabel(row: Row): HTMLDivElement {
  if (row.decision === null) return element('div', 'status status-pending', '… Pending');
  if (row.decision.verdict === 'match') return element('div', 'status status-match', '✓ Meets selected filters');
  if (row.decision.verdict === 'no-match') return element('div', 'status status-no-match', '× Does not match');
  return element('div', 'status status-unknown', '? Unknown');
}

function runwaySummary(row: Row): string {
  if (row.decision === null) return 'Pending';
  if (row.decision.runwayIds.length) {
    const prefix = row.decision.verdict === 'match' ? '' : row.decision.verdict === 'unknown' ? 'Uncertain: ' : 'Evaluated: ';
    return `${prefix}${row.decision.runwayIds.join(', ')}`;
  }
  if (row.decision.verdict === 'match') return 'No specific runway';
  return row.facility.status === 'unknown' ? row.facility.reason : 'None';
}

function runwayGeometry(row: Row): string {
  const matching = matchingRunwayLength(row);
  if (matching !== null) return `${displayLength(matching)} from threshold`;
  if (row.facility.status !== 'ready' || row.decision === null) return 'Unknown';
  const ids = new Set(row.decision.runwayIds);
  const candidates = (row.facility.airport.ends ?? [])
    .filter(end => ids.has(end.id))
    .map(end => end.physicalM !== null && end.thresholdM !== null && end.physicalM >= end.thresholdM && end.thresholdM >= 0
      ? end.physicalM - end.thresholdM : null)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return candidates.length ? displayLength(Math.max(...candidates)) : 'Unknown';
}

function availableCategories(row: Row): string[] {
  if (row.facility.status !== 'ready' || row.facility.airport.procedures === null) return [];
  const values = new Set<string>();
  for (const procedure of row.facility.airport.procedures) {
    if (procedure.type === 4) values.add('ILS');
    else if (procedure.type === 5) values.add('LOC');
    else if (procedure.type === 8) values.add('VOR');
    else if (procedure.type === 11) values.add('VOR/DME');
    else if (procedure.type === 10) {
      if (procedure.rnavFlags !== null && (procedure.rnavFlags & 8) !== 0) values.add('LPV');
      if (procedure.rnavFlags !== null && (procedure.rnavFlags & 2) !== 0) values.add('LNAV/VNAV');
      if (procedure.rnavFlags === null || procedure.rnavFlags <= 0) values.add('RNAV subtype unknown');
    }
  }
  return [...values];
}

function procedureType(procedure: Procedure): string {
  const base = procedure.type === 4 ? 'ILS' : procedure.type === 5 ? 'LOC'
    : procedure.type === 8 ? 'VOR' : procedure.type === 11 ? 'VOR/DME'
    : procedure.type === 10 ? 'RNAV' : `Type ${procedure.type}`;
  if (procedure.type !== 10) return base;
  const categories: string[] = [];
  if (procedure.rnavFlags !== null && (procedure.rnavFlags & 8) !== 0) categories.push('LPV');
  if (procedure.rnavFlags !== null && (procedure.rnavFlags & 2) !== 0) categories.push('LNAV/VNAV');
  return `${base}${categories.length ? ` · ${categories.join(' · ')}` : ' · subtype unknown'}`;
}

function metric(label: string, value: string): HTMLElement {
  const item = element('div', 'metric');
  item.append(element('small', '', label), element('strong', 'figure', value));
  return item;
}

async function savePreferences(next: Preferences): Promise<void> {
  const version = ++saveVersion;
  preferences = next;
  applyTheme();
  try {
    const accepted = await window.companion.setPreferences(next);
    if (version === saveVersion) {
      preferences = accepted;
      applyTheme();
      renderTable(true);
    }
  } catch (error) {
    if (version === saveVersion) {
      warning.hidden = false;
      warning.textContent = error instanceof Error ? error.message : 'The setting could not be applied.';
    }
  }
}

function syncPreferenceControls(): void {
  if (!preferences) return;
  theme.value = preferences.theme;
  appearance.value = preferences.appearance;
  compact.checked = preferences.compact;
  keepOnTop.checked = preferences.keepOnTop;
  port.value = String(preferences.port);
  minimum.value = preferences.criteria.minimumFt === null ? '' : String(preferences.criteria.minimumFt);
  matchesOnly.checked = preferences.matchesOnly;
  for (const control of categoryControls) control.checked = preferences.criteria.categories.includes(control.dataset.category as Category);
}

function applyTheme(): void {
  if (!preferences) return;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.mode = preferences.appearance === 'system'
    ? systemMode.matches ? 'night' : 'light'
    : preferences.appearance;
  document.documentElement.dataset.compact = String(preferences.compact);
  const themeName = preferences.theme === 'deck' ? 'Flight deck' : preferences.theme === 'notes' ? 'Field notes' : 'Clear';
  const appearanceName = preferences.appearance === 'system' ? 'Follow system' : preferences.appearance === 'light' ? 'Light' : 'Night';
  settingsSummary.textContent = `${themeName} · ${appearanceName} · local port ${preferences.port}`;
}

function bindAction(id: string, action: () => Promise<void>): void {
  const button = required<HTMLButtonElement>(id);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); }
    catch (error) {
      connectionMessage.textContent = error instanceof Error ? error.message : 'The requested action could not be completed.';
      document.querySelector<HTMLElement>('.message-strip')!.hidden = false;
    }
    finally { button.disabled = false; }
  });
}

function setupMessage(value: AppState['connection']): string {
  if (value === 'unavailable') return 'Start MSFS 2024 and choose Retry connection.';
  if (value === 'views-unavailable') return 'Open the simulator’s Career Missions view, expand the native mission list, then retry.';
  if (value === 'inactive') return 'Open Career Missions and expand the native mission list.';
  if (value === 'briefing') return 'Return to the Career Missions browser to resume current results.';
  if (value === 'unsupported') return 'Return to the supported Career Missions browser.';
  if (value === 'updating') return 'The simulator list is changing; the last complete snapshot remains visible.';
  if (value === 'stalled') return 'A native simulator request has not settled. Retry joins the existing request safely.';
  if (value === 'ready') return 'Current Career mission candidates are available.';
  return 'Connecting to MSFS 2024…';
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function detailId(guid: string): string {
  return `mission-details-${guid.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}



function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function required<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing renderer element: ${id}`);
  return value as T;
}
