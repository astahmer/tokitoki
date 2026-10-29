import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class TokitokiExtension extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._label = new St.Label({ text: "tokitoki …" });
        this._button.add_child(this._label);
        // St widgets have no tooltips; details live in the panel menu instead.
        this._details = new PopupMenu.PopupMenuItem("Waiting for tokitoki", { reactive: false });
        this._button.menu.addMenuItem(this._details);
        Main.panel.addToStatusArea(this.uuid, this._button);

        this._running = false;
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        this._button?.destroy();
        this._button = null;
        this._label = null;
        this._details = null;
    }

    _show(label, details) {
        this._label.text = label;
        this._details.label.text = details;
    }

    _refresh() {
        // A slow run must finish before the next one, or --notify runs skip
        // each other on the shared lock.
        if (this._running) return;
        let process;
        try {
            process = Gio.Subprocess.new(
                ["tokitoki", "widget-payload", "--cached", "--notify", "--json"],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (_error) {
            this._show("tokitoki ?", "tokitoki is not available on PATH");
            return;
        }

        this._running = true;
        process.communicate_utf8_async(null, null, (source, result) => {
            this._running = false;
            if (this._label === null) return;

            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                const payload = JSON.parse(stdout);
                if (payload.schema !== 1 || payload.app !== "tokitoki") {
                    throw new Error("unsupported widget payload");
                }
                const stats = payload.stats ?? {};
                const cost = Number(stats.costUsd ?? 0).toFixed(2);
                const tokens = Math.round(Number(stats.tokens ?? 0)).toLocaleString();
                this._show(
                    `$${cost} · ${tokens}`,
                    `${payload.window?.label ?? "today"} · ${stats.requests ?? 0} requests · ${stats.sessions ?? 0} sessions`,
                );
            } catch (_error) {
                this._show("tokitoki ?", "tokitoki widget payload unavailable");
            }
        });
    }
}
