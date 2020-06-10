#!/usr/bin/env gjs

/**
 * Thumbnailer from Polari
 *
 * Credits: https://gitlab.gnome.org/GNOME/polari/-/merge_requests/134
 */

imports.gi.versions.Gdk = '3.0';
imports.gi.versions.Gtk = '3.0';

const {Gdk, Gio, GLib, GObject, Gtk, WebKit2} = imports.gi;
const Cairo = imports.cairo;

Gio._promisify(WebKit2.WebView.prototype, 'get_snapshot', 'get_snapshot_finish');
Gio._promisify(WebKit2.WebView.prototype, 'run_javascript', 'run_javascript_finish');

const PREVIEW_WIDTH = 120;
const PREVIEW_HEIGHT = 90;

let PreviewWindow = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
    },
    Signals: {
        'snapshot-ready': {},
        'snapshot-failed': {},
    },
}, class PreviewWindow extends Gtk.Window {
    _init(params) {
        this._snapshot = null;

        super._init(params);

        let settings = new WebKit2.Settings({
            hardware_acceleration_policy: WebKit2.HardwareAccelerationPolicy.NEVER,
        });

        this._view = new WebKit2.WebView({
            is_ephemeral: true,
            visible: true,
            settings,
        });
        this.add(this._view);

        this._view.bind_property('title',
            this, 'title', GObject.BindingFlags.SYNC_CREATE);

        this._view.connect('authenticate', (view, request) => {
            request.cancel();
            return true;
        });

        this._view.connect('notify::is-loading',
            this._onLoadingChanged.bind(this));
        this._view.connect('load-failed', () => this.emit('snapshot-failed'));
        this._view.load_uri(this.uri);

        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._view.stop_loading();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onLoadingChanged() {
        if (this._view.is_loading)
            return;

        /* Hopefully wait long enough for a meaningful snapshot,
           see https://bugs.webkit.org/show_bug.cgi?id=164180 */
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._createSnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _createSnapshot() {
        let getClipOp = this._getImageClip();
        let snapshotOp = this._view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE,
            WebKit2.SnapshotOptions.NONE,
            null);
        let clip, snapshot;

        try {
            clip = await getClipOp;
            snapshot = await snapshotOp;
        } catch (e) {
            log(`Creating snapshot failed: ${e}`);
            this.emit('snapshot-failed');
            return;
        }

        if (clip)
            this._snapshot = this._createClippedSurface(snapshot, clip);
        else
            this._snapshot = snapshot;

        this.emit('snapshot-ready');
    }

    async _getImageClip() {
        const script = `
            const img = document.images[0];
            document.contentType.startsWith('image')
                ? [img.x, img.y, img.width, img.height]
                : null;
        `;

        let obj = null;

        try {
            let res = await this._view.run_javascript(script, null);
            obj = res.get_js_value();
        } catch (e) {
            log(`Failed to get clip information: ${e} (${e.code})`);
        }

        if (!obj || obj.is_null())
            return null;

        let [x, y, width, height] = obj.object_enumerate_properties()
            .map(p => obj.object_get_property(p).to_int32());

        if (width === 0 || height === 0)
            throw new Error('Invalid image clip');

        return {x, y, width, height};
    }

    _createClippedSurface(source, clip) {
        let {x, y, width, height} = clip;

        let surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);

        let cr = new Cairo.Context(surface);
        cr.setSourceSurface(source, -x, -y);
        cr.paint();
        cr.$dispose();

        return surface;
    }

    getSnapshot() {
        return this._snapshot;
    }
});

class App {
    constructor(url, filename) {
        this._uri = url;
        this._filename = filename;
    }

    run() {
        Gtk.init(null);

        let window = new PreviewWindow({
            uri: this._uri,
            default_width: 10 * PREVIEW_WIDTH,
            default_height: 10 * PREVIEW_HEIGHT,
        });

        window.realize();
        window.connect('snapshot-ready', this._onSnapshotReady.bind(this));
        window.connect('snapshot-failed', () => window.destroy());
        window.connect('destroy', () => Gtk.main_quit());

        Gtk.main();
    }

    _onSnapshotReady(window) {
        let surface = window.getSnapshot();
        let title = window.title || this._uri;
        window.destroy();

        if (!surface)
            return;

        let sourceWidth = surface.getWidth();
        let sourceHeight = surface.getHeight();
        let ratio = sourceWidth / sourceHeight;

        let targetWidth, targetHeight;
        if (ratio >= PREVIEW_WIDTH / PREVIEW_HEIGHT) {
            targetWidth = Math.min(sourceWidth, PREVIEW_WIDTH);
            targetHeight = targetWidth / ratio;
        } else {
            targetHeight = Math.min(sourceHeight, PREVIEW_HEIGHT);
            targetWidth = targetHeight * ratio;
        }

        let target = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            targetWidth,
            targetHeight);

        let cr = new Cairo.Context(target);
        cr.scale(
            targetWidth / sourceWidth,
            targetHeight / sourceHeight);
        cr.setSourceSurface(surface, 0, 0);
        cr.paint();
        cr.$dispose();

        let pixbuf = Gdk.pixbuf_get_from_surface(target,
            0, 0, targetWidth, targetHeight);
        pixbuf.savev(this._filename, 'png', ['tEXt::Title'], [title]);
    }
}

let [url, filename] = ARGV;
let app = new App(url, filename);
app.run();

