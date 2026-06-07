import path from "path";
import { BrowserWindow, dialog, shell, Menu } from "electron";
import {
  OverlayController,
  OVERLAY_WINDOW_OPTS,
} from "electron-overlay-window";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";

export class OverlayWindow {
  public isInteractable = false;
  public wasUsedRecently = true;
  private window?: BrowserWindow;
  get electronWindow() {
    return this.window;
  }
  public overlayKey: string = "Shift + Space";
  private isOverlayKeyUsed = false;
  private allowInputEnterReactivation = false;
  private onDeactivateCallbacks: Array<() => void> = [];

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient(
      "OVERLAY->MAIN::focus-game",
      this.assertGameActive,
    );
    this.poeWindow.on("active-change", this.handlePoeWindowActiveChange);
    this.poeWindow.onAttach(this.handleOverlayAttached);
    if (process.platform === "linux") {
      OverlayController.events.on("input-enter", this.handleInputEnter);
    }

    this.server.onEventAnyClient("CLIENT->MAIN::used-recently", (e) => {
      this.wasUsedRecently = e.isOverlay;
    });

    if (process.argv.includes("--no-overlay")) return;

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      ...OVERLAY_WINDOW_OPTS,
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    this.window.webContents.on("before-input-event", this.handleExtraCommands);
    this.window.webContents.on(
      "did-attach-webview",
      (_, webviewWebContents) => {
        webviewWebContents.on("before-input-event", this.handleExtraCommands);
      },
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });
  }

  loadAppPage(port: number) {
    const url =
      process.env.VITE_DEV_SERVER_URL || `http://localhost:${port}/index.html`;

    if (!this.window) {
      shell.openExternal(url);
      return;
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url);
      this.window.webContents.openDevTools({ mode: "detach", activate: false });
    } else {
      this.window.loadURL(url);
    }
  }

  assertOverlayActive = () => {
    if (!this.isInteractable) {
      this.logger.write("debug [Overlay] assertOverlayActive: activating");
      this.isInteractable = true;
      OverlayController.activateOverlay();
      this.poeWindow.isActive = false;
    }
  };

  refreshOverlayActive = () => {
    if (this.isInteractable) {
      this.logger.write("debug [Overlay] refreshOverlayActive: reactivating");
      OverlayController.activateOverlay();
      this.poeWindow.isActive = false;
      return;
    }

    this.assertOverlayActive();
  };

  returnFocusToGame = () => {
    if (!this.isInteractable) return;

    this.logger.write(
      "debug [Overlay] returnFocusToGame: deactivating (preserving session)",
    );
    this.isInteractable = false;
    this.armInputEnterReactivation("mouse-leave");
    OverlayController.focusTarget();
    this.poeWindow.isActive = true;
  };

  assertGameActive = () => {
    if (!this.isInteractable && !this.allowInputEnterReactivation) return;

    if (this.isInteractable) {
      this.logger.write("debug [Overlay] assertGameActive: deactivating");
    } else {
      this.logger.write(
        "debug [Overlay] assertGameActive: dismissing preserved widget session",
      );
    }

    this.isInteractable = false;
    if (this.allowInputEnterReactivation) {
      this.disarmInputEnterReactivation("explicit dismiss");
    }
    if (process.platform === "linux") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::hide-exclusive-widget",
        payload: undefined,
      });
    }
    for (const cb of this.onDeactivateCallbacks) cb();
    OverlayController.focusTarget();
    this.poeWindow.isActive = true;
  };

  private lastToggleTime = 0;

  toggleActiveState = () => {
    // Guard against double-toggle: on Linux, both globalShortcut and uiohook
    // fire for the same keypress. Without this, globalShortcut activates the
    // overlay, then uiohook sees isInteractable=true and toggles it back off.
    const now = Date.now();
    if (now - this.lastToggleTime < 100) return;
    this.lastToggleTime = now;

    this.isOverlayKeyUsed = true;
    if (process.platform === "linux" && this.allowInputEnterReactivation) {
      this.assertGameActive();
    } else if (this.isInteractable) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  updateOpts(overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey;
    this.poeWindow.attach(this.window, windowTitle);
  }

  get isAwaitingInputEnterReactivation() {
    return this.allowInputEnterReactivation;
  }

  onDeactivate(cb: () => void) {
    this.onDeactivateCallbacks.push(cb);
  }

  private armInputEnterReactivation(reason: string) {
    if (this.allowInputEnterReactivation) return;
    this.allowInputEnterReactivation = true;
    this.logger.write(
      `debug [Overlay] input-enter reactivation: armed (${reason})`,
    );
  }

  private disarmInputEnterReactivation(reason: string) {
    if (!this.allowInputEnterReactivation) return;
    this.allowInputEnterReactivation = false;
    this.logger.write(
      `debug [Overlay] input-enter reactivation: disarmed (${reason})`,
    );
  }

  private handleExtraCommands = (
    event: Electron.Event,
    input: Electron.Input,
  ) => {
    if (input.type !== "keyDown") return;
    // On Linux, uiohook handles overlay dismissal (Escape, overlay key)
    // instead of before-input-event, which requires electronWindow.focus().
    if (process.platform === "linux") return;

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input;

    if (code.startsWith("Key")) {
      code = code.slice("Key".length);
    } else if (code.startsWith("Digit")) {
      code = code.slice("Digit".length);
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
    else if (altKey) code = `Alt + ${code}`;
    else if (ctrlKey) code = `Ctrl + ${code}`;
    else if (shiftKey) code = `Shift + ${code}`;

    switch (code) {
      case "Escape":
      case "Ctrl + W": {
        event.preventDefault();
        process.nextTick(this.assertGameActive);
        break;
      }
      case this.overlayKey: {
        event.preventDefault();
        process.nextTick(this.toggleActiveState);
        break;
      }
    }
  };

  handleInputEnter = () => {
    if (!this.allowInputEnterReactivation || this.isInteractable) {
      this.logger.write(
        `debug [Overlay] input-enter: ignored (armed=${this.allowInputEnterReactivation} isInteractable=${this.isInteractable})`,
      );
      return;
    }

    this.logger.write(
      "debug [Overlay] input-enter: reactivating overlay, disarming on return",
    );
    this.disarmInputEnterReactivation("cursor return");
    this.assertOverlayActive();
  };

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write(
        "error [Overlay] PoE2 is running with administrator rights",
      );

      dialog.showErrorBox(
        "PoE2 window - No access",
        // ----------------------
        "Path of Exile 2 is running with administrator rights.\n" +
          "\n" +
          "You need to restart Exiled Exchange 2 with administrator rights.",
      );
    } else {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
    }
  };

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (process.platform === "linux") {
      if (isActive && this.isInteractable) {
        this.logger.write(
          "debug [Overlay] game focus event while interactable: keeping overlay active on Linux",
        );
      }
      const preserveWidgets = isActive && this.allowInputEnterReactivation;
      this.logger.write(
        `debug [Overlay] focus-change: game=${isActive} overlay=${this.isInteractable} preserveWidgets=${preserveWidgets}`,
      );
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::focus-change",
        payload: {
          game: isActive,
          overlay: this.isInteractable,
          usingHotkey: this.isOverlayKeyUsed,
          preserveWidgets,
        },
      });
      this.isOverlayKeyUsed = false;
      return;
    }

    if (isActive && this.isInteractable) {
      this.isInteractable = false;
    }
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::focus-change",
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
      },
    });
    this.isOverlayKeyUsed = false;
  };
}
