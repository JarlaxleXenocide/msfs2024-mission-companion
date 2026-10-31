interface Bounds { minimum: number | null; maximum: number | null }
interface RangeOptions {
  label: string;
  unit: string;
  step: number;
  ceiling: number;
  minimumId: string;
  maximumId: string;
  errorId: string;
  numberStep?: number;
  description: string;
}

/** Two native sliders share a track; number fields also support precise/open bounds. */
export class RangeFilter {
  private bounds: Bounds = { minimum: null, maximum: null };
  private limit: number;
  private readonly lower: HTMLInputElement;
  private readonly upper: HTMLInputElement;
  private readonly minimum: HTMLInputElement;
  private readonly maximum: HTMLInputElement;
  private readonly output: HTMLOutputElement;
  private readonly error: HTMLElement;
  private readonly fill: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: RangeOptions,
    private readonly onInput: (bounds: Bounds) => void,
    private readonly onChange: () => void,
  ) {
    this.limit = options.ceiling + options.step;
    root.className = 'range-filter';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', options.label);
    // Options are application constants; airport/user values never enter this markup.
    root.innerHTML = `<div class="range-heading"><strong>${options.label}</strong><output></output><button type="button" aria-label="Clear ${options.label.toLowerCase()} filter">Clear</button></div>
      <div class="range-track"><span class="range-rail"></span><span class="range-fill"></span>
        <input class="range-lower" type="range" min="0" step="${options.step}" aria-label="Minimum ${options.label.toLowerCase()} slider" />
        <input class="range-upper" type="range" min="0" step="${options.step}" aria-label="Maximum ${options.label.toLowerCase()} slider" />
      </div>
      <div class="range-values"><label>From <input id="${options.minimumId}" type="number" min="0" step="${options.numberStep ?? 'any'}" placeholder="Any" aria-label="Minimum ${options.label.toLowerCase()} in ${options.unit}" /></label>
        <label>To <input id="${options.maximumId}" type="number" min="0" step="${options.numberStep ?? 'any'}" placeholder="Any" aria-label="Maximum ${options.label.toLowerCase()} in ${options.unit}" /></label><span>${options.unit}</span></div>
      <small id="${options.errorId}" class="field-error" role="alert"></small>`;
    root.title = options.description;
    this.lower = root.querySelector('.range-lower')!;
    this.upper = root.querySelector('.range-upper')!;
    this.minimum = root.querySelector(`#${options.minimumId}`)!;
    this.maximum = root.querySelector(`#${options.maximumId}`)!;
    this.output = root.querySelector('output')!;
    this.error = root.querySelector('.field-error')!;
    this.fill = root.querySelector('.range-fill')!;
    for (const control of [this.lower, this.upper]) {
      control.addEventListener('input', () => {
        const value = Number(control.value);
        if (control === this.lower) {
          const next = Math.min(value, this.bounds.maximum ?? this.limit - options.step);
          this.bounds.minimum = next === 0 ? null : next;
        } else {
          this.bounds.maximum = value === this.limit ? null : Math.max(value, this.bounds.minimum ?? 0);
        }
        this.clearError();
        this.sync();
        onInput({ ...this.bounds });
      });
      control.addEventListener('change', onChange);
    }
    for (const control of [this.minimum, this.maximum]) {
      control.setAttribute('aria-describedby', options.errorId);
      control.addEventListener('input', () => this.clearError());
      control.addEventListener('change', () => {
        const minimum = this.read(this.minimum);
        const maximum = this.read(this.maximum);
        if (minimum === undefined || maximum === undefined ||
            (minimum !== null && maximum !== null && minimum > maximum)) {
          this.error.textContent = `Enter nonnegative values${options.numberStep ? ` in steps of ${options.numberStep}` : ''} with From ≤ To, or leave blank.`;
          control.setAttribute('aria-invalid', 'true');
          return;
        }
        this.set({ minimum, maximum });
        onInput({ ...this.bounds });
        onChange();
      });
    }
    root.querySelector('button')!.addEventListener('click', () => {
      this.set({ minimum: null, maximum: null });
      onInput({ ...this.bounds });
      onChange();
    });
    this.sync();
  }

  set(bounds: Bounds): void {
    this.bounds = { ...bounds };
    this.limit = Math.ceil(Math.max(this.options.ceiling, bounds.minimum ?? 0, bounds.maximum ?? 0) / this.options.step) * this.options.step + this.options.step;
    this.clearError();
    this.sync();
  }

  private read(control: HTMLInputElement): number | null | undefined {
    if (control.validity.badInput) return undefined;
    if (!control.value.trim()) return null;
    const value = Number(control.value);
    return Number.isFinite(value) && value >= 0 && (!this.options.numberStep || Number.isSafeInteger(value / this.options.numberStep)) ? value : undefined;
  }

  private clearError(): void {
    this.error.textContent = '';
    this.minimum.removeAttribute('aria-invalid');
    this.maximum.removeAttribute('aria-invalid');
  }

  private sync(): void {
    const { minimum, maximum } = this.bounds;
    this.minimum.value = minimum === null ? '' : String(minimum);
    this.maximum.value = maximum === null ? '' : String(maximum);
    for (const slider of [this.lower, this.upper]) slider.max = String(this.limit);
    this.lower.value = String(minimum ?? 0);
    this.upper.value = String(maximum ?? this.limit);
    this.lower.setAttribute('aria-valuetext', minimum === null ? 'No minimum' : `${minimum} ${this.options.unit}`);
    this.upper.setAttribute('aria-valuetext', maximum === null ? 'No maximum' : `${maximum} ${this.options.unit}`);
    this.lower.style.zIndex = Number(this.lower.value) === 0 ? '4' : '2';
    this.lower.parentElement!.dataset.overlap = String(this.lower.value === this.upper.value);
    this.lower.setAttribute('aria-valuemax', String(maximum ?? this.limit - this.options.step));
    this.upper.setAttribute('aria-valuemin', String(minimum ?? 0));
    this.fill.style.left = `${Number(this.lower.value) / this.limit * 100}%`;
    this.fill.style.right = `${100 - Number(this.upper.value) / this.limit * 100}%`;
    const format = (value: number) => value.toLocaleString('en-US');
    this.output.textContent = minimum === null && maximum === null ? 'Any'
      : maximum === null ? `${format(minimum!)}+ ${this.options.unit}`
      : `${format(minimum ?? 0)}–${format(maximum)} ${this.options.unit}`;
  }
}
