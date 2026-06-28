import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** A tab item rendered by {@link TabBar}. */
export interface Tab {
  /** Stable identifier used for activation and callbacks. */
  id: string;
  /** Full label shown when horizontal space allows. */
  label: string;
  /** Compact label used when the bar needs to shrink to fit. */
  short?: string;
  /** Muted tabs are styled as disabled and skipped by keyboard navigation. */
  muted?: boolean;
}

/** Styling hooks for {@link TabBar}. */
export interface TabBarTheme {
  /** Style for the optional label prefix, for example `Settings:`. */
  label: (text: string) => string;
  /** Style for the selected tab. */
  activeTab: (text: string) => string;
  /** Style for selectable, inactive tabs. */
  inactiveTab: (text: string) => string;
  /** Style for the keyboard hint. */
  hint: (text: string) => string;
  /** Style for muted tabs. Falls back to `inactiveTab`. */
  mutedTab?: (text: string) => string;
  /** Style for the hovered inactive tab. Falls back to `inactiveTab`. */
  hoverTab?: (text: string) => string;
}

interface HitZone {
  line: number;
  start: number;
  end: number;
  index: number;
}

interface TabChunk {
  text: string;
  /** Index into the tab array when this chunk is a clickable tab. */
  tabIndex?: number;
}

function clampTabIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function requiredTab(tabs: readonly Tab[], index: number): Tab {
  const tab = tabs[index];
  if (tab === undefined) throw new RangeError(`Tab index ${index} is out of range.`);
  return tab;
}

/**
 * Horizontal tab selector ported from Oh My Pi's TUI package.
 *
 * It keeps the active tab visible, collapses distant tabs to their `short`
 * label when the terminal is narrow, records mouse hit zones during render,
 * and handles Tab/Shift+Tab/Left/Right keyboard navigation.
 */
export class TabBar implements Component {
  #tabs: Tab[];
  #activeIndex: number;
  #theme: TabBarTheme;
  #label: string;
  #hoverTabId: string | null = null;
  #hitZones: HitZone[] = [];

  /** Called after the active tab changes through navigation or selection. */
  onTabChange?: (tab: Tab, index: number) => void;

  /** Render the trailing `(tab to cycle)` hint. */
  showHint = true;

  constructor(label: string, tabs: Tab[], theme: TabBarTheme, initialIndex = 0) {
    this.#label = label;
    this.#tabs = tabs;
    this.#theme = theme;
    this.#activeIndex = clampTabIndex(initialIndex, tabs.length);
  }

  /** Return the currently active tab. Throws when constructed with no tabs. */
  getActiveTab(): Tab {
    return requiredTab(this.#tabs, this.#activeIndex);
  }

  /** Return the current active tab index. */
  getActiveIndex(): number {
    return this.#activeIndex;
  }

  /** Set the active tab by index, clamped to the available tab range. */
  setActiveIndex(index: number): void {
    const newIndex = clampTabIndex(index, this.#tabs.length);
    if (this.#tabs.length === 0) {
      this.#activeIndex = 0;
      return;
    }
    if (newIndex !== this.#activeIndex) {
      this.#activeIndex = newIndex;
      this.onTabChange?.(requiredTab(this.#tabs, this.#activeIndex), this.#activeIndex);
    }
  }

  /**
   * Replace all tabs without firing `onTabChange`.
   *
   * The active tab is preserved by id when possible, or forced by `activeId`.
   * If neither id exists in the new set, the previous index is clamped.
   */
  setTabs(tabs: Tab[], activeId?: string): void {
    const targetId = activeId ?? this.#tabs[this.#activeIndex]?.id;
    this.#tabs = tabs;
    const index = targetId === undefined ? -1 : tabs.findIndex((tab) => tab.id === targetId);
    this.#activeIndex = index >= 0 ? index : clampTabIndex(this.#activeIndex, tabs.length);
  }

  /** Set active tab by id without firing `onTabChange`. */
  setActiveById(id: string): boolean {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return false;
    this.#activeIndex = index;
    return true;
  }

  /** Activate a non-muted tab by id, firing `onTabChange` if it changes. */
  selectTab(id: string): boolean {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    const tab = this.#tabs[index];
    if (index === -1 || tab === undefined || tab.muted) return false;
    this.setActiveIndex(index);
    return true;
  }

  /** Move to the next non-muted tab, wrapping around. */
  nextTab(): void {
    this.#stepTab(1);
  }

  /** Move to the previous non-muted tab, wrapping around. */
  prevTab(): void {
    this.#stepTab(-1);
  }

  #stepTab(delta: -1 | 1): void {
    const length = this.#tabs.length;
    if (length === 0) return;

    for (let step = 1; step <= length; step++) {
      const index = (((this.#activeIndex + delta * step) % length) + length) % length;
      const tab = this.#tabs[index];
      if (tab !== undefined && !tab.muted) {
        this.setActiveIndex(index);
        return;
      }
    }
  }

  invalidate(): void {
    this.#hitZones = [];
  }

  /** Handle Tab/Shift+Tab/Right/Left keyboard navigation. */
  handleInput(data: string): boolean {
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.nextTab();
      return true;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.prevTab();
      return true;
    }
    return false;
  }

  /**
   * Render the tab bar for a terminal width.
   *
   * Full labels are used first. If they overflow, tabs farthest from the
   * active tab collapse to their `short` label before the bar wraps lines.
   */
  render(width: number): string[] {
    const maxWidth = Math.max(1, width);
    const labels = this.#tabs.map((tab) => tab.label);
    let chunks = this.#buildChunks(labels);

    if (this.#totalWidth(chunks) > maxWidth) {
      const collapseOrder = this.#tabs
        .map((_, index) => index)
        .filter((index) => index !== this.#activeIndex && this.#tabs[index]?.short !== undefined)
        .sort((a, b) => Math.abs(b - this.#activeIndex) - Math.abs(a - this.#activeIndex));

      for (const index of collapseOrder) {
        const tab = this.#tabs[index];
        if (tab === undefined) continue;
        labels[index] = tab.short ?? tab.label;
        chunks = this.#buildChunks(labels);
        if (this.#totalWidth(chunks) <= maxWidth) break;
      }
    }

    return this.#renderChunks(chunks, maxWidth);
  }

  #buildChunks(labels: readonly string[]): TabChunk[] {
    const chunks: TabChunk[] = [];

    if (this.#label) {
      chunks.push({ text: this.#theme.label(`${this.#label}:`) });
      chunks.push({ text: "  " });
    }

    for (let index = 0; index < this.#tabs.length; index++) {
      const tab = this.#tabs[index];
      if (tab === undefined) continue;

      const hovered = tab.id === this.#hoverTabId && !tab.muted && index !== this.#activeIndex;
      const style = tab.muted
        ? (this.#theme.mutedTab ?? this.#theme.inactiveTab)
        : index === this.#activeIndex
          ? this.#theme.activeTab
          : hovered
            ? (this.#theme.hoverTab ?? this.#theme.inactiveTab)
            : this.#theme.inactiveTab;

      chunks.push({ text: style(` ${labels[index] ?? tab.label} `), tabIndex: index });
      if (index < this.#tabs.length - 1) chunks.push({ text: "  " });
    }

    if (this.showHint) {
      chunks.push({ text: "  " });
      chunks.push({ text: this.#theme.hint("(tab to cycle)") });
    }

    return chunks;
  }

  #totalWidth(chunks: readonly TabChunk[]): number {
    return chunks.reduce((sum, chunk) => sum + visibleWidth(chunk.text), 0);
  }

  #renderChunks(chunks: readonly TabChunk[], maxWidth: number): string[] {
    this.#hitZones = [];
    const lines: string[] = [];
    let currentLine = "";
    let currentWidth = 0;

    for (const chunk of chunks) {
      const chunkWidth = visibleWidth(chunk.text);
      if (chunkWidth <= 0) continue;

      if (chunkWidth > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = "";
          currentWidth = 0;
        }
        if (chunk.tabIndex !== undefined) {
          this.#hitZones.push({ line: lines.length, start: 0, end: maxWidth, index: chunk.tabIndex });
        }
        lines.push(truncateToWidth(chunk.text, maxWidth));
        continue;
      }

      if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
        lines.push(currentLine);
        currentLine = "";
        currentWidth = 0;
      }

      if (chunk.tabIndex !== undefined) {
        this.#hitZones.push({
          line: lines.length,
          start: currentWidth,
          end: currentWidth + chunkWidth,
          index: chunk.tabIndex,
        });
      }

      currentLine += chunk.text;
      currentWidth += chunkWidth;
    }

    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [""];
  }

  /** Resolve a pointer location from the last render to the tab under it. */
  tabAt(line: number, col: number): Tab | undefined {
    for (const zone of this.#hitZones) {
      if (zone.line === line && col >= zone.start && col < zone.end) {
        return this.#tabs[zone.index];
      }
    }
    return undefined;
  }

  /** Highlight the tab under the pointer. Pass `null` to clear hover. */
  setHoverTab(id: string | null): void {
    this.#hoverTabId = id;
  }
}
