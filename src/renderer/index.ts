import type {
  AppState,
  Category,
  Preferences,
  Procedure,
  Row,
  RunwayEnd,
} from '../shared/model';
import { RangeFilter } from './range-filter';
import { classify, groupRunways } from '../domain/classify';
import stylesURL from './styles.css';
import radioIconURL from './assets/radio-assist.png';
import { RouteMapController } from './route-map';
import {
  displayElevation,
  displayCreditsPerHour,
  availableCategories,
  procedureType,
  displayLength,
  matchingRunwayLength,
  missionSummary,
  rowCounts,
  recommendedRows,
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
const radioEnabled = required<HTMLInputElement>('radio-enabled');
required<HTMLImageElement>('radio-icon').src = radioIconURL;
const radioStatus = required<HTMLElement>('radio-status');
const radioFrequency = required<HTMLElement>('radio-frequency');
const radioLatest = required<HTMLElement>('radio-latest');
const radioAction = required<HTMLElement>('radio-action');
const radioError = required<HTMLElement>('radio-error');
const radioActivity = required<HTMLButtonElement>('radio-activity');
const radioPanel = required<HTMLElement>('radio-activity-panel');
radioPanel.addEventListener('beforetoggle', event => {
  if ((event as ToggleEvent).newState !== 'open') return;
  const anchor = radioActivity.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 24);
  radioPanel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 120);
  radioPanel.style.top = `${top}px`;
  radioPanel.style.maxHeight = `${window.innerHeight - top - 12}px`;
});
radioPanel.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); radioPanel.hidePopover(); radioActivity.focus(); }
});
required('radio-activity-close').addEventListener('click', () => radioActivity.focus());
const dismissRadioActivity = () => { if (radioPanel.matches(':popover-open')) radioPanel.hidePopover(); };
window.addEventListener('resize', dismissRadioActivity);
required('app').querySelector('.workspace')!.addEventListener('scroll', dismissRadioActivity);
let radioPending = false;
let stateVersion = 0;
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
let recommendationSignature = '';
const recommendationsList = required<HTMLElement>('recommendations-list');

const durationFilter = new RangeFilter(required('duration-filter'), {
  label: 'Duration', unit: 'hours', step: 0.5, ceiling: 24, numberStep: 0.5,
  minimumId: 'duration-minimum', maximumId: 'duration-maximum', errorId: 'duration-error',
  description: 'Estimated flight duration, inclusive. Drag in 30-minute steps or type hours (0.5 = 30 minutes); blank means no limit.',
}, bounds => {
  if (!preferences) return;
  saveVersion++;
  preferences = { ...preferences, duration: { minimumHours: bounds.minimum, maximumHours: bounds.maximum } };
  renderTable(true);
}, () => { if (preferences) void savePreferences(preferences); });
const distanceFilter = new RangeFilter(required('distance-filter'), {
  label: 'Distance from player', unit: 'NM', step: 25, ceiling: 1000,
  minimumId: 'distance-minimum', maximumId: 'distance-maximum', errorId: 'distance-error',
  description: 'Straight-line distance from your current Career airport to the mission departure. Drag in 25 NM steps or type exact nautical miles; blank means no limit.',
}, bounds => {
  if (!preferences) return;
  saveVersion++;
  preferences = { ...preferences, distance: { minimumNm: bounds.minimum, maximumNm: bounds.maximum } };
  renderTable(true);
}, () => { if (preferences) void savePreferences(preferences); });

const creditsFilter = new RangeFilter(required('credits-filter'), {
  label: 'Total Credits', unit: 'Cr.', step: 500000, ceiling: 10000000, numberStep: 500000,
  minimumId: 'credits-minimum', maximumId: 'credits-maximum', errorId: 'credits-error',
  description: 'Advertised total mission payout, not credits per hour. Adjust in 500,000-credit steps; blank means no limit.',
  formatValue: value => value >= 1000000 ? `${value / 1000000}M` : `${value / 1000}k`,
}, bounds => {
  if (!preferences) return;
  saveVersion++;
  preferences = { ...preferences, credits: { minimumCredits: bounds.minimum, maximumCredits: bounds.maximum } };
  renderTable(true);
}, () => { if (preferences) void savePreferences(preferences); });

const unsubscribe = window.companion.subscribe(acceptState);
radioEnabled.addEventListener('change', async () => {
  const enabled = radioEnabled.checked;
  const version = stateVersion;
  radioPending = true; radioEnabled.disabled = true;
  radioError.hidden = true;
  try {
    const radio = await window.companion.setRadioEnabled(enabled);
    if (state && stateVersion === version) state = { ...state, radio };
  } catch (error) {
    radioError.textContent = error instanceof Error ? error.message : 'Radio assist could not be changed.';
    radioError.hidden = false;
  } finally { radioPending = false; renderRadio(); }
});
addEventListener('unload', () => { routeMap.dispose(); unsubscribe(); }, { once: true });
systemMode.addEventListener('change', () => applyTheme());

for (const control of categoryControls) control.addEventListener('change', () => {
  if (!preferences) return;
  const categories = categoryControls
    .filter(input => input.checked)
    .map(input => input.dataset.category as Category);
  void savePreferences({ ...preferences, criteria: { ...preferences.criteria, categories } });
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

bindAction('retry', () => window.companion.retry());
bindAction('refresh', () => {
  routeMap.dismiss();
  return window.companion.refreshAirports();
});

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
  stateVersion++;
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
  observedAt.textContent = state.observedAt ? `Last scan ${formatTime(state.observedAt)}` : 'No mission scan yet';
  connectionMessage.textContent = state.message || setupMessage(state.connection);
  renderRadio();

  warning.hidden = !state.desktop?.preferenceWarning;
  warning.textContent = state.desktop?.preferenceWarning ?? '';
  const managed = state.desktop?.keepOnTop === 'desktop-managed';
  pinControl.hidden = managed;
  desktopHelp.hidden = !managed;
  desktopHelp.textContent = managed ? state.desktop?.keepOnTopHelp ?? '' : '';
  minimizeHelp.hidden = state.desktop?.minimizePolling !== 'desktop-limited';

  renderTable();
  routeMap.update(state);
}

function renderRadio(): void {
  const radio = state?.radio;
  radioEnabled.disabled = radioPending || !radio;
  radioEnabled.checked = radio?.enabled ?? false;
  required<HTMLElement>('radio-power').textContent = radioEnabled.checked ? 'On' : 'Off';
  radioStatus.textContent = radio?.message ?? 'Radio assist is off';
  radioStatus.dataset.state = radio?.status ?? 'off';
  const alert = required<HTMLElement>('radio-alert');
  alert.hidden = radio?.status !== 'paused';
  alert.title = radio?.message ?? '';
  radioActivity.title = radio?.message ?? 'Radio activity';
  radioFrequency.textContent = radio?.frequency ? `${radio.agent || 'Radio'} · ${radio.frequency.toFixed(3)} MHz` : '';
  radioLatest.textContent = radio?.latestMessage || 'No radio messages yet';
  radioAction.textContent = radio?.lastAction ? `Last action sent: ${radio.lastAction}` : 'No action sent';
  const shutdown = required<HTMLElement>('radio-last-shutdown');
  shutdown.hidden = !radio?.lastShutdown;
  shutdown.textContent = radio?.lastShutdown ? `Last automatic shutoff · ${new Date(radio.lastShutdown.at).toLocaleString()}: ${radio.lastShutdown.reason}` : '';
  const logPath = required<HTMLElement>('radio-log-path');
  logPath.hidden = !radio?.logPath;
  logPath.textContent = radio?.logPath ? `Local radio log: ${radio.logPath}` : '';
  const logWarning = required<HTMLElement>('radio-log-warning');
  logWarning.hidden = !radio?.logWarning;
  logWarning.textContent = radio?.logWarning ?? '';
}

function renderTable(force = false): void {
  if (!state || !preferences) return;
  const signature = JSON.stringify([state.rows, state.pilotLocation, state.rows.length ? null : [state.connection, state.stale], search.value, preferences.matchesOnly, preferences.criteria, preferences.duration, preferences.distance, preferences.credits, sorts, preferences.compact, [...expanded], selectedGuid]);
  // Reclassify previews locally while dragging, before preferences are persisted.
  const classified = state.rows.map(row => ({ ...row, decision:
    row.facility.status === 'pending' && (preferences!.criteria.categories.length > 0 || preferences!.criteria.minimumFt !== null || preferences!.criteria.maximumFt != null)
      ? null : classify(row.facility.status === 'ready' ? row.facility.airport : null, preferences!.criteria) }));
  const rows = visibleRows(classified, search.value, preferences.matchesOnly, sorts, preferences);
  renderRecommendations(rows);
  const aggregate = rowCounts(classified);
  const prefix = state.stale ? 'Last known · ' : '';
  counts.textContent = `${prefix}${rows.length} shown / ${state.rows.length} scanned · ${aggregate.match} match · ${aggregate.noMatch} not matching · ${aggregate.pending} pending · ${aggregate.unknown} unknown`;
  if (!force && signature === tableSignature) return;
  tableSignature = signature;
  const missionRows = new Map(Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr.mission-row[data-guid]'))
    .map(row => [row.dataset.guid!, row]));
  const detailRows = new Map(Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr.details-row[data-detail-guid]'))
    .map(row => [row.dataset.detailGuid!, row]));
  const desired: HTMLTableRowElement[] = [];
  if (rows.length === 0) {
    const row = element('tr', 'empty-row');
    const empty = element('td', '', state.rows.length ? 'No missions match the current view.'
      : state.connection === 'ready' && !state.stale ? 'No missions scanned yet. Pan the Career map to find missions.'
      : 'No current mission list is available. Check simulator status above.');
    empty.colSpan = 8;
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

function renderRecommendations(rows: Row[]): void {
  required('recommendations-freshness').textContent = state?.stale ? 'Last known · stale' : '';
  const recommendations = recommendedRows(rows);
  const signature = JSON.stringify(recommendations);
  if (signature === recommendationSignature) return;
  recommendationSignature = signature;
  required('recommendations-count').textContent = String(recommendations.length);
  const best = recommendations[0];
  required('recommendations-best').textContent = best
    ? `Best: ${best.mission.departure} → ${best.mission.destination} · ${displayCreditsPerHour(best.mission)} Cr./h` : '';
  if (!recommendations.length) {
    recommendationsList.replaceChildren(element('p', 'recommendations-empty',
      'No qualifying flights with known credits/hour and player distance. Adjust filters or scan more missions.'));
    return;
  }
  recommendationsList.replaceChildren(...recommendations.map((row, index) => {
    const card = element('article', 'recommendation-card');
    card.dataset.guid = row.mission.guid;
    card.title = row.mission.title;
    card.append(element('strong', 'recommendation-route', `${index + 1}. ${row.mission.departure} → ${row.mission.destination}`),
      element('div', 'recommendation-rate', `${displayCreditsPerHour(row.mission)} Cr./h`),
      element('div', 'secondary', `${row.mission.durationText} · ${row.distanceNm!.toLocaleString('en-US', { maximumFractionDigits: 1 })} NM away`));
    const view = element('button', '', 'View flight ↗');
    view.type = 'button';
    view.ariaLabel = `View recommended flight ${row.mission.title}`;
    view.addEventListener('click', () => {
      selectedGuid = row.mission.guid;
      expanded.add(row.mission.guid);
      renderTable(true);
      const target = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('.mission-row'))
        .find(candidate => candidate.dataset.guid === row.mission.guid);
      target?.scrollIntoView({ block: 'nearest' });
      target?.querySelector<HTMLButtonElement>('.expand')?.focus({ preventScroll: true });
    });
    card.append(view);
    return card;
  }));
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
  missionRow.append(...Array.from({ length: 7 }, () => element('td')), toggleCell);
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
  const toggle = missionRow.cells[7].querySelector<HTMLButtonElement>('button')!;
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
  missionRow.cells[4].textContent = displayCreditsPerHour(row.mission);
  const distanceCell = missionRow.cells[5];
  distanceCell.textContent = row.distanceNm == null ? '—' : row.distanceNm.toLocaleString('en-US', { maximumFractionDigits: 1 });
  distanceCell.title = state?.pilotLocation
    ? `Your current Career location at ${state.pilotLocation.ident} to mission departure at ${row.mission.departure} (straight-line distance in nautical miles)`
    : 'Your current Career player location is unavailable';
  const categories = categoryCell(row);
  missionRow.cells[6].className = categories.className;
  missionRow.cells[6].replaceChildren(...Array.from(categories.childNodes));
  missionRow.cells[7].replaceChildren(
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
  container.colSpan = 8;
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
  durationFilter.set({ minimum: preferences.duration?.minimumHours ?? null, maximum: preferences.duration?.maximumHours ?? null });
  distanceFilter.set({ minimum: preferences.distance?.minimumNm ?? null, maximum: preferences.distance?.maximumNm ?? null });
  creditsFilter.set({ minimum: preferences.credits?.minimumCredits ?? null, maximum: preferences.credits?.maximumCredits ?? null });
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
