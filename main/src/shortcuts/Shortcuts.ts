import { screen, globalShortcut } from "electron";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;
  private lastMousePosition?: { x: number; y: number };
  private linuxCopyLatchKey: string | null = null;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay, logger);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.register();
          } else {
            this.unregister();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      } else if (e.action === "debug-log") {
        this.logger.write(`debug [Renderer] ${e.text}`);
      } else if (e.action === "activate-overlay") {
        this.overlay.refreshOverlayActive();
      } else if (e.action === "price-check-clicked") {
        this.areaTracker.confirmLinuxAreaClick();
      }
    });

    uIOhook.on("keydown", (e) => {
      if (this.logKeys) {
        const pressed = eventToString(e);
        this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
      }

      if (process.platform === "linux") {
        const pressed = eventToString(e);
        const copyItemAction = this.actions.find(
          (entry) =>
            entry.action.type === "copy-item" && entry.shortcut === pressed,
        );
        if (copyItemAction && this.poeWindow.isActive) {
          if (this.linuxCopyLatchKey) return;
          this.linuxCopyLatchKey = copyItemAction.shortcut;
          this.executeAction(copyItemAction);
          return;
        }

        // On Linux, uiohook handles overlay dismissal instead of
        // before-input-event (which requires electronWindow.focus() —
        // a non-starter for override-redirect windows on X11).
        if (
          pressed === this.overlay.overlayKey &&
          (this.poeWindow.isActive ||
            this.overlay.isInteractable ||
            this.overlay.isAwaitingInputEnterReactivation)
        ) {
          this.logger.write(
            `debug [Overlay] keyboard toggle: ${this.overlay.overlayKey}`,
          );
          this.areaTracker.removeListeners();
          this.overlay.toggleActiveState();
          return;
        }

        if (
          !this.overlay.isInteractable &&
          !this.overlay.isAwaitingInputEnterReactivation
        ) {
          return;
        }

        if (pressed === "Escape") {
          this.logger.write("debug [Overlay] keyboard dismiss: Escape");
          this.overlay.assertGameActive();
        } else if (pressed === this.overlay.overlayKey) {
          this.logger.write(
            `debug [Overlay] keyboard dismiss: ${this.overlay.overlayKey}`,
          );
          this.overlay.assertGameActive();
        }
      }
    });
    uIOhook.on("mousemove", (e) => {
      this.lastMousePosition = { x: e.x, y: e.y };
    });
    uIOhook.on("mousedown", (e) => {
      this.lastMousePosition = { x: e.x, y: e.y };
    });
    uIOhook.on("keyup", (e) => {
      const name = UiohookToName[e.keycode] || "not_supported_key";
      if (this.logKeys) {
        this.logger.write(`debug [Shortcuts] Keyup ${name}`);
      }
      // Clear the copy-item latch when the non-modifier key of the exact
      // latched shortcut is released. This prevents auto-repeat from
      // starting a second copy while the first is still in flight.
      if (
        process.platform === "linux" &&
        this.linuxCopyLatchKey &&
        this.linuxCopyLatchKey.endsWith(name)
      ) {
        this.linuxCopyLatchKey = null;
      }
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          uIOhook.keyTap(UiohookKey.ArrowRight);
        } else if (e.rotation < 0) {
          uIOhook.keyTap(UiohookKey.ArrowLeft);
        }
      }
    });
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );
  }

  private register() {
    for (const entry of this.actions) {
      // On Linux, copy-item actions are handled via uiohook keydown to avoid
      // the DIP/physical pixel race that affects globalShortcut + getCursorScreenPoint.
      if (process.platform === "linux" && entry.action.type === "copy-item") {
        continue;
      }

      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => this.executeAction(entry),
      );

      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    globalShortcut.unregisterAll();
  }

  private executeAction(entry: ShortcutAction) {
    if (this.logKeys) {
      this.logger.write(`debug [Shortcuts] Action type: ${entry.action.type}`);
    }

    const skipGenericKeyRelease =
      process.platform === "linux" && entry.action.type === "copy-item";

    if (!skipGenericKeyRelease && entry.keepModKeys) {
      const nonModKey = entry.shortcut
        .split(" + ")
        .filter((key) => !isModKey(key))[0];
      uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
    } else if (!skipGenericKeyRelease) {
      entry.shortcut
        .split(" + ")
        .reverse()
        .forEach((key) => {
          uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
        });
    }

    if (entry.action.type === "toggle-overlay") {
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;
      const pressPosition = this.getCopyItemPressPosition();

      this.clipboard
        .readItemText()
        .then((clipboard) => {
          this.areaTracker.removeListeners();
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::item-text",
            payload: {
              target: action.target,
              clipboard,
              position: pressPosition,
              focusOverlay: Boolean(action.focusOverlay),
            },
          });
          if (action.focusOverlay && this.overlay.wasUsedRecently) {
            this.overlay.assertOverlayActive();
          }
        })
        .catch(() => {});

      pressKeysToCopyItemText(
        entry.keepModKeys
          ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
          : undefined,
        this.gameConfig.showModsKey,
      );
    } else if (
      entry.action.type === "ocr-text" &&
      entry.action.target === "heist-gems"
    ) {
      if (process.platform !== "win32") return;

      const { action } = entry;
      const pressTime = Date.now();
      const imageData = this.poeWindow.screenshot();
      this.ocrWorker
        .findHeistGems({
          width: this.poeWindow.bounds.width,
          height: this.poeWindow.bounds.height,
          data: imageData,
        })
        .then((result) => {
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::ocr-text",
            payload: {
              target: action.target,
              pressTime,
              ocrTime: result.elapsed,
              paragraphs: result.recognized.map((p) => p.text),
            },
          });
        })
        .catch(() => {});
    }
  }

  private getCopyItemPressPosition() {
    const rawCursor = screen.getCursorScreenPoint();
    const cursor =
      process.platform === "linux"
        ? screen.dipToScreenPoint(rawCursor)
        : rawCursor;

    if (process.platform !== "linux" || !this.lastMousePosition) {
      return cursor;
    }

    const dx = Math.abs(this.lastMousePosition.x - cursor.x);
    const dy = Math.abs(this.lastMousePosition.y - cursor.y);
    if (dx > 8 || dy > 8) {
      this.logger.write(
        `debug [Shortcuts] Linux cursor mismatch: uiohook=(${this.lastMousePosition.x},${this.lastMousePosition.y}) electron=(${cursor.x},${cursor.y})`,
      );
    }
    return { ...this.lastMousePosition };
  }
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "down");
  }

  // finally press `C` to copy text
  uIOhook.keyTap(UiohookKey.C);

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}
