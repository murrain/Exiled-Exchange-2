import type { BrowserWindow } from "electron";
import { EventEmitter } from "events";
import { OverlayController, AttachEvent } from "electron-overlay-window";

export interface GameWindow {
  on: (event: "active-change", listener: (isActive: boolean) => void) => this;
}
export class GameWindow extends EventEmitter {
  private _isActive = false;
  private _isTracking = false;
  // Debounce timer for game-blur events. On X11, _NET_ACTIVE_WINDOW can
  // bounce (game → none → game) when the overlay is override-redirect.
  // Game-focus (true) is always emitted immediately; game-blur (false)
  // waits for the bounce window to close.
  private _blurTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressNextBlur = false;

  get bounds() {
    return OverlayController.targetBounds;
  }

  get isActive() {
    return this._isActive;
  }

  /**
   * Suppress the next game-blur event. Call this immediately before an
   * operation that steals focus from the game (e.g. showing a companion
   * window), so the resulting blur is not propagated to subscribers.
   * The flag is consumed by the next blur or cleared by a focus event.
   */
  suppressNextBlur() {
    this._suppressNextBlur = true;
  }

  set isActive(active: boolean) {
    if (active) {
      if (this._blurTimer) {
        clearTimeout(this._blurTimer);
        this._blurTimer = null;
      }
      this._suppressNextBlur = false;
      if (!this._isActive) {
        this._isActive = true;
        this.emit("active-change", true);
      }
    } else if (this._isActive && !this._blurTimer) {
      if (this._suppressNextBlur) {
        this._suppressNextBlur = false;
        return;
      }
      if (process.platform === "linux") {
        this._blurTimer = setTimeout(() => {
          this._blurTimer = null;
          if (this._isActive) {
            this._isActive = false;
            this.emit("active-change", false);
          }
        }, 60);
      } else {
        this._isActive = false;
        this.emit("active-change", false);
      }
    }
  }

  get uiSidebarWidth() {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600;
    return Math.round(this.bounds.height * ratio);
  }

  attach(window: BrowserWindow | undefined, title: string) {
    if (!this._isTracking) {
      OverlayController.events.on("focus", () => {
        this.isActive = true;
      });
      OverlayController.events.on("blur", () => {
        this.isActive = false;
      });
      OverlayController.attachByTitle(window, title, {
        hasTitleBarOnMac: true,
      });
      this._isTracking = true;
    }
  }

  onAttach(cb: (hasAccess: boolean | undefined) => void) {
    OverlayController.events.on("attach", (e: AttachEvent) => {
      cb(e.hasAccess);
    });
  }

  screenshot() {
    return OverlayController.screenshot();
  }
}
