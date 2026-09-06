import * as L from 'leaflet';
import leafletStylesURL from 'leaflet/dist/leaflet.css';
import type { AppState, Mission, RouteEndpoint } from '../shared/model';
import { routePoints } from './route-geometry';

export type AttributionKey = 'osm' | 'leaflet';

export class RouteMapController {
  private readonly popup = this.createPopup();
  private state: AppState | null = null;
  private snapshot: Mission | null = null;
  private snapshotSession: string | null = null;
  private routeSnapshot: AppState['route'] = null;
  private anchor: HTMLButtonElement | null = null;
  private map: L.Map | null = null;
  private tiles: L.TileLayer | null = null;
  private overlay: L.LayerGroup | null = null;
  private overlayKey = '';
  private pinned = false;
  private visible = false;
  private tileFailed = false;
  private awaitingRetrySuccess = false;
  private needsFrame = true;
  private openTimer?: number;
  private closeTimer?: number;
  private view = 0;

  constructor(
    private readonly routes: HTMLElement,
    private readonly selectRoute: (guid: string | null) => Promise<void>,
    private readonly openAttribution: (key: AttributionKey) => void = () => {},
  ) {
    const leaflet = document.createElement('link');
    leaflet.rel = 'stylesheet';
    leaflet.href = leafletStylesURL;
    document.head.append(leaflet);
    document.body.append(this.popup);
    routes.addEventListener('mouseover', this.onRouteOver);
    routes.addEventListener('mouseout', this.onRouteOut);
    routes.addEventListener('click', this.onRouteClick);
    this.popup.addEventListener('mouseenter', this.cancelClose);
    this.popup.addEventListener('mouseleave', this.scheduleClose);
    this.popup.addEventListener('click', this.onPopupClick);
    document.addEventListener('keydown', this.onKeyDown);
    addEventListener('resize', this.onResize);
    document.addEventListener('scroll', this.onScroll, true);
  }

  update(state: AppState): void {
    this.state = state;
    if (!this.visible || !this.snapshot) return;
    this.anchor = this.findAnchor(this.snapshot.guid);
    if (!this.anchor && !this.pinned) {
      this.close(false);
      return;
    }
    this.position();
    this.updateExpanded();
    this.render(state.route?.mission.guid === this.snapshot.guid ? state.route : null);
  }

  dispose(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.routes.removeEventListener('mouseover', this.onRouteOver);
    this.routes.removeEventListener('mouseout', this.onRouteOut);
    this.routes.removeEventListener('click', this.onRouteClick);
    document.removeEventListener('keydown', this.onKeyDown);
    removeEventListener('resize', this.onResize);
    document.removeEventListener('scroll', this.onScroll, true);
    this.map?.remove();
    this.popup.remove();
  }

  private readonly onRouteOver = (event: MouseEvent): void => {
    const button = this.routeButton(event.target);
    if (!button || this.pinned) return;
    clearTimeout(this.closeTimer);
    clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      if (button.isConnected && this.findAnchor(button.dataset.routeGuid!) === button) this.open(button, false);
    }, 300);
  };

  private readonly onRouteOut = (event: MouseEvent): void => {
    const button = this.routeButton(event.target);
    if (!button || button.contains(event.relatedTarget as Node | null)) return;
    clearTimeout(this.openTimer);
    this.scheduleClose();
  };

  private readonly onRouteClick = (event: MouseEvent): void => {
    const button = this.routeButton(event.target);
    if (!button) return;
    event.stopPropagation();
    this.open(button, true);
  };

  private readonly onPopupClick = (event: MouseEvent): void => {
    const action = (event.target as Element).closest<HTMLButtonElement>('[data-route-action]')?.dataset.routeAction;
    if (!action) return;
    if (action === 'pin') this.pin();
    else if (action === 'close') this.close(true);
    else if (action === 'route') this.showRoute();
    else if (action === 'departure') this.focusDeparture();
    else if (action === 'retry') this.retryTiles();
    else if (action === 'osm' || action === 'leaflet') this.openAttribution(action);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.visible) {
      event.preventDefault();
      this.close(true);
    }
  };

  private readonly onScroll = (): void => {
    if (!this.visible || this.pinned || !this.anchor) return;
    const anchor = this.anchor.getBoundingClientRect();
    const scroller = this.routes.closest('.table-scroll')?.getBoundingClientRect();
    if (anchor.bottom <= Math.max(0, scroller?.top ?? 0) || anchor.top >= Math.min(innerHeight, scroller?.bottom ?? innerHeight)) this.close(false);
  };

  private readonly onResize = (): void => {
    if (!this.visible) return;
    this.position();
    this.map?.invalidateSize({ animate: false });
  };

  private readonly cancelClose = (): void => { clearTimeout(this.closeTimer); };
  private readonly scheduleClose = (): void => {
    clearTimeout(this.closeTimer);
    if (!this.pinned) this.closeTimer = window.setTimeout(() => this.close(false), 200);
  };

  private open(button: HTMLButtonElement, pinned: boolean): void {
    const mission = this.state?.rows.find(row => row.mission.guid === button.dataset.routeGuid)?.mission;
    if (!mission) return;
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.snapshot = { ...mission };
    this.snapshotSession = this.state!.session;
    this.routeSnapshot = null;
    this.anchor = button;
    this.pinned = pinned;
    this.visible = true;
    this.tileFailed = false;
    this.awaitingRetrySuccess = false;
    this.needsFrame = true;
    this.popup.hidden = false;
    this.updateExpanded();
    this.position();
    this.render(this.state?.route ?? null);
    void this.selectRoute(mission.guid);
  }

  private pin(): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    this.pinned = true;
    this.updateExpanded();
    this.render(this.state?.route ?? null);
  }

  private close(restoreFocus: boolean): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    const guid = this.snapshot?.guid;
    this.visible = false;
    this.pinned = false;
    this.snapshot = null;
    this.snapshotSession = null;
    this.routeSnapshot = null;
    this.anchor = null;
    this.view++;
    this.map?.stop();
    this.overlay?.clearLayers();
    this.overlayKey = '';
    this.popup.hidden = true;
    this.tiles?.remove();
    this.tiles = null;
    this.updateExpanded();
    void this.selectRoute(null);
    if (restoreFocus && guid) window.setTimeout(() => this.findAnchor(guid)?.focus());
  }

  private render(route: AppState['route']): void {
    if (!this.snapshot) return;
    this.text('route-map-title', `${this.snapshot.departure} → ${this.snapshot.destination}`);
    this.text('route-map-subtitle', `${this.snapshot.title} · ${this.snapshot.activity}`);
    if (route && route.session === this.snapshotSession && route.session === this.state?.session && route.mission.guid === this.snapshot.guid) {
      this.routeSnapshot = route;
    }
    const departure = this.routeSnapshot?.departure ?? null;
    const destination = this.routeSnapshot?.destination ?? null;
    const status: string[] = [];
    if (!this.anchor) status.push(this.state?.rows.some(row => row.mission.guid === this.snapshot!.guid)
      ? 'Mission is no longer in the current view.' : 'Mission is no longer in the current list.');
    if (this.state?.stale || this.snapshotSession !== this.state?.session) status.push('Route snapshot is stale.');
    status.push(this.endpointStatus(departure, destination));
    if (this.tileFailed || this.awaitingRetrySuccess) status.push('Map imagery unavailable.');
    this.text('route-map-status', status.join(' '));
    this.button('route-pin').textContent = this.pinned ? 'Pinned' : 'Pin map';
    this.button('route-pin').setAttribute('aria-pressed', String(this.pinned));
    this.button('route-departure').disabled = departure?.status !== 'ready';
    this.button('route-retry').hidden = !this.tileFailed && !this.awaitingRetrySuccess;
    this.button('route-retry').disabled = this.awaitingRetrySuccess;

    const departurePosition = departure?.status === 'ready' ? departure.position : null;
    const destinationPosition = destination?.status === 'ready' ? destination.position : null;
    const points = routePoints(departurePosition, destinationPosition);
    if (!points) {
      this.tiles?.remove();
      this.tiles = null;
      this.overlay?.clearLayers();
      this.overlayKey = '';
      return;
    }
    this.ensureMap();
    const overlayKey = JSON.stringify([this.snapshotSession, this.snapshot.guid, departure, destination]);
    if (overlayKey !== this.overlayKey) {
      this.draw(points, departure, destination);
      this.overlayKey = overlayKey;
    }
    if (!this.tiles && !this.tileFailed) this.addTiles();
    this.map!.invalidateSize({ animate: false });
    if (this.needsFrame) {
      this.frame(points);
      this.needsFrame = departure?.status === 'pending' || destination?.status === 'pending';
    }
  }

  private endpointStatus(departure: RouteEndpoint | null, destination: RouteEndpoint | null): string {
    if (!departure || !destination || departure.status === 'pending' || destination.status === 'pending') return 'Loading airport locations…';
    if (departure.status === 'ready' && destination.status === 'ready') return 'Route locations available.';
    if (departure.status === 'ready') return `Destination ${destination.ident} unavailable.`;
    if (destination.status === 'ready') return `Departure ${departure.ident} unavailable.`;
    return 'Airport locations unavailable.';
  }

  private ensureMap(): void {
    if (this.map) return;
    this.map = L.map(this.popup.querySelector<HTMLElement>('#route-map')!, { scrollWheelZoom: false, fadeAnimation: false, attributionControl: false });
    this.overlay = L.layerGroup().addTo(this.map);
    // A user-selected view wins over airports that finish loading later.
    for (const event of ['pointerdown', 'keydown', 'wheel']) {
      this.map.getContainer().addEventListener(event, () => { this.needsFrame = false; });
    }
  }

  private addTiles(): void {
    if (!this.map || !this.visible) return;
    const current = ++this.view;
    let failed = false;
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '' })
      .on('tileerror', () => {
        if (current !== this.view) return;
        failed = true;
        this.awaitingRetrySuccess = false;
        this.tileFailed = true;
        this.tiles?.remove();
        this.tiles = null;
        this.render(this.state?.route ?? null);
      })
      .on('load', () => {
        if (current !== this.view || failed || !this.awaitingRetrySuccess) return;
        this.awaitingRetrySuccess = false;
        this.tileFailed = false;
        this.render(this.state?.route ?? null);
      })
      .addTo(this.map);
  }

  private retryTiles(): void {
    this.tileFailed = false;
    this.awaitingRetrySuccess = true;
    this.addTiles();
    this.render(this.state?.route ?? null);
  }

  private draw(points: [number, number][], departure: RouteEndpoint | null, destination: RouteEndpoint | null): void {
    this.overlay!.clearLayers();
    if (points.length === 2) L.polyline(points, { color: '#167a95', weight: 3, dashArray: '7 7' }).addTo(this.overlay!);
    [departure, destination].forEach((endpoint, index) => {
      if (endpoint?.status !== 'ready') return;
      const point = points[points.length === 1 ? 0 : index];
      const label = document.createElement('span');
      label.className = 'route-airport-label';
      label.textContent = `${index ? 'B' : 'A'} · ${endpoint.ident} · ${index ? 'Destination' : 'Departure'}`;
      const eastbound = points.length < 2 || points[0][1] <= points[1][1];
      const direction = (index === 0) === eastbound ? 'right' : 'left';
      L.circleMarker(point, { radius: 7, color: '#fff', weight: 3, fillColor: index ? '#b56228' : '#06778c', fillOpacity: 1 })
        .bindTooltip(label, { permanent: true, direction, className: 'route-tooltip' }).addTo(this.overlay!);
    });
  }

  private frame(points: [number, number][]): void {
    if (!this.map) return;
    this.map.stop();
    if (points.length === 1) this.map.setView(points[0], 9, { animate: false });
    else this.map.fitBounds(L.latLngBounds(points), { padding: [68, 40], maxZoom: 9, animate: false });
  }

  private showRoute(): void {
    const route = this.routeSnapshot;
    if (!route) return;
    const points = routePoints(route.departure.status === 'ready' ? route.departure.position : null, route.destination.status === 'ready' ? route.destination.position : null);
    if (points) {
      this.frame(points);
      this.needsFrame = false;
    }
  }

  private focusDeparture(): void {
    this.needsFrame = false;
    const departure = this.routeSnapshot?.departure;
    if (departure?.status === 'ready') this.map?.setView([departure.position.latitude, departure.position.longitude], 9, { animate: false });
  }

  private position(): void {
    if (!this.visible) return;
    const anchor = this.anchor?.getBoundingClientRect();
    const rect = this.popup.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(innerWidth - rect.width - margin, anchor?.left ?? margin));
    const below = (anchor?.bottom ?? margin) + 8;
    const top = below + rect.height <= innerHeight - margin ? below : Math.max(margin, (anchor?.top ?? margin) - rect.height - 8);
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  private updateExpanded(): void {
    document.querySelectorAll<HTMLButtonElement>('.route-trigger').forEach(button => button.setAttribute('aria-expanded', String(this.visible && button.dataset.routeGuid === this.snapshot?.guid)));
  }

  private findAnchor(guid: string): HTMLButtonElement | null {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.route-trigger')).find(button => button.dataset.routeGuid === guid) ?? null;
  }

  private routeButton(target: EventTarget | null): HTMLButtonElement | null {
    return target instanceof Element ? target.closest<HTMLButtonElement>('.route-trigger[data-route-guid]') : null;
  }

  private text(id: string, value: string): void { this.popup.querySelector<HTMLElement>(`#${id}`)!.textContent = value; }
  private button(id: string): HTMLButtonElement { return this.popup.querySelector<HTMLButtonElement>(`#${id}`)!; }

  private createPopup(): HTMLElement {
    const popup = document.createElement('section');
    popup.id = 'route-map-popup';
    popup.className = 'route-map-popup';
    popup.hidden = true;
    popup.setAttribute('aria-label', 'Route map');
    popup.innerHTML = `<div class="route-map-head"><div><strong id="route-map-title"></strong><small id="route-map-subtitle"></small></div><div class="route-map-actions"><button id="route-pin" type="button" data-route-action="pin" aria-pressed="false">Pin map</button><button id="route-close" type="button" data-route-action="close" aria-label="Close route map">×</button></div></div><div id="route-map"></div><div class="route-map-toolbar"><span><button id="route-departure" type="button" data-route-action="departure">Focus departure</button> <button id="route-show" type="button" data-route-action="route">Show route</button></span><button id="route-retry" type="button" data-route-action="retry" hidden>Retry imagery</button></div><p id="route-map-status" class="route-map-status" aria-live="polite"></p><p class="route-attribution"><button type="button" data-route-action="leaflet">Leaflet</button> · © <button type="button" data-route-action="osm">OpenStreetMap contributors</button></p>`;
    return popup;
  }
}
