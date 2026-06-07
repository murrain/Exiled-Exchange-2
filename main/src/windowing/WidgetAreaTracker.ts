import { Rectangle, Point, screen } from "electron";
import { uIOhook, UiohookMouseEvent } from "uiohook-napi";
import type { OverlayWindow } from "./OverlayWindow";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";

export class WidgetAreaTracker {
  private holdKey!: string;
  private from!: Point;
  private area!: Rectangle;
  private closeThreshold!: number;
  private hasEnteredArea = false;
  private hasClickedInsideArea = false;
  private listenersAttached = false;

  constructor(
    private server: ServerEvents,
    private overlay: OverlayWindow,
    private logger: Logger,
  ) {
    this.overlay.onDeactivate(() => this.removeListeners());

    this.server.onEventAnyClient("OVERLAY->MAIN::track-area", (opts) => {
      this.holdKey = opts.holdKey;

      if (process.platform === "win32") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;
        this.from = screen.dipToScreenPoint(opts.from);
        // NOTE: bug in electron accepting only integers
        this.area = screen.dipToScreenRect(null, roundRect(opts.area));
      } else if (process.platform === "linux") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;

        const display = screen.getDisplayNearestPoint(opts.from);
        const scaleX = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.x,
            display.nativeOrigin.x,
            display.scaleFactor,
          );
        const scaleY = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.y,
            display.nativeOrigin.y,
            display.scaleFactor,
          );

        // scale coordinates using the display scale factor.
        this.from = {
          x: scaleX(opts.from.x),
          y: scaleY(opts.from.y),
        };

        this.area = roundRect({
          x: scaleX(opts.area.x),
          y: scaleY(opts.area.y),
          width: opts.area.width * display.scaleFactor,
          height: opts.area.height * display.scaleFactor,
        });
      } else {
        this.closeThreshold = opts.closeThreshold;
        this.from = opts.from;
        this.area = opts.area;
      }

      this.hasEnteredArea =
        process.platform === "linux"
          ? false
          : isPointInsideRect(this.from, this.area);
      this.hasClickedInsideArea = false;
      this.removeListeners();

      if (process.platform === "linux") {
        this.logger.write(
          `debug [WidgetAreaTracker] track-area registered on Linux, activating overlay immediately ` +
            `(hasEnteredArea=${this.hasEnteredArea} from=${this.from.x},${this.from.y} ` +
            `area=${this.area.x},${this.area.y} ${this.area.width}x${this.area.height})`,
        );
        this.overlay.assertOverlayActive();
        return;
      }
      this.attachListeners();
    });
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    uIOhook.addListener("mousemove", this.handleMouseMove);
    uIOhook.addListener("mousedown", this.handleMouseDown);
    this.listenersAttached = true;
  }

  removeListeners() {
    if (!this.listenersAttached) return;
    uIOhook.removeListener("mousemove", this.handleMouseMove);
    uIOhook.removeListener("mousedown", this.handleMouseDown);
    this.listenersAttached = false;
  }

  confirmLinuxAreaClick() {
    if (process.platform !== "linux") return;
    this.hasClickedInsideArea = true;
    this.hasEnteredArea = true;
    this.logger.write(
      "debug [WidgetAreaTracker] renderer confirmed price-check click inside tracked area",
    );
    this.attachListeners();
  }

  private readonly handleMouseMove = (e: UiohookMouseEvent) => {
    const modifier = e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : undefined;
    const inside = isPointInsideRect(e, this.area);

    if (!this.overlay.isInteractable) {
      if (this.overlay.isAwaitingInputEnterReactivation) {
        if (inside) {
          this.logger.write(
            "debug [WidgetAreaTracker] input-enter: cursor returned to tracked area",
          );
          this.hasEnteredArea = true;
          this.overlay.handleInputEnter();
        }
        return;
      }

      if (modifier === this.holdKey) {
        if (inside) {
          if (process.platform !== "linux") {
            this.hasEnteredArea = true;
          }
          this.overlay.assertOverlayActive();
        }
        return;
      }

      const distance = Math.hypot(e.x - this.from.x, e.y - this.from.y);
      if (inside) {
        this.logger.write(
          `debug [WidgetAreaTracker] activate: cursor inside area without holdKey` +
            ` (modifier=${modifier ?? "none"} holdKey=${this.holdKey})`,
        );
        if (process.platform !== "linux") {
          this.hasEnteredArea = true;
        }
        this.overlay.assertOverlayActive();
      } else if (distance > this.closeThreshold) {
        if (process.platform === "linux") {
          this.logger.write(
            `debug [WidgetAreaTracker] distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, keeping widget armed on Linux`,
          );
        } else {
          this.logger.write(
            `debug [WidgetAreaTracker] dismiss: distance ${distance.toFixed(0)} > threshold ${this.closeThreshold.toFixed(0)}, hiding widget`,
          );
          this.server.sendEventTo("broadcast", {
            name: "MAIN->OVERLAY::hide-exclusive-widget",
            payload: undefined,
          });
          this.removeListeners();
        }
      }
      return;
    }

    if (inside) {
      if (process.platform !== "linux" || this.hasClickedInsideArea) {
        this.hasEnteredArea = true;
      }
      this.overlay.assertOverlayActive();
      return;
    }

    if (this.overlay.isInteractable) {
      if (process.platform === "linux" && !this.hasClickedInsideArea) return;
      if (!this.hasEnteredArea) return;
      this.logger.write(
        `debug [WidgetAreaTracker] mouse left area: isInteractable=true hasEnteredArea=true platform=${process.platform}`,
      );
      if (process.platform === "linux") {
        this.overlay.returnFocusToGame();
        return;
      }
      this.removeListeners();
      this.overlay.assertGameActive();
    }
  };

  private readonly handleMouseDown = (e: UiohookMouseEvent) => {
    const inside = isPointInsideRect(e, this.area);
    this.logger.write(
      `debug [WidgetAreaTracker] mousedown at ${e.x},${e.y} inside=${inside} area=${this.area.x},${this.area.y} ${this.area.width}x${this.area.height}`,
    );
    if (
      process.platform === "linux" &&
      inside &&
      this.overlay.isInteractable &&
      !this.hasClickedInsideArea
    ) {
      this.logger.write(
        "debug [WidgetAreaTracker] first inside mousedown on Linux: waiting for renderer confirmation",
      );
      return;
    }
    if (inside) {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown inside area, activating overlay",
      );
      this.hasClickedInsideArea = true;
      this.hasEnteredArea = true;
      if (
        this.overlay.isAwaitingInputEnterReactivation &&
        !this.overlay.isInteractable
      ) {
        this.overlay.handleInputEnter();
        return;
      }
      this.removeListeners();
      this.overlay.assertOverlayActive();
      return;
    }

    if (
      this.overlay.isInteractable ||
      this.overlay.isAwaitingInputEnterReactivation
    ) {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown outside area, dismissing widget session",
      );
      this.overlay.assertGameActive();
      return;
    }

    if (process.platform === "linux") {
      this.logger.write(
        "debug [WidgetAreaTracker] mousedown outside area while not interactable, dismissing widget",
      );
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::hide-exclusive-widget",
        payload: undefined,
      });
      this.removeListeners();
    }
  };
}

function isPointInsideRect(point: Point, rect: Rectangle) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function roundRect(rect: Rectangle) {
  // NOTE: bug in electron accepting only integers
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function scaleNumberByDisplay(
  value: number,
  boundValue: number,
  nativeValue: number,
  scaleFactor: number,
) {
  return (value - boundValue + nativeValue) * scaleFactor;
}
