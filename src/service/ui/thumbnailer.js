/**
 * Based on the thumbnailer from Polari
 *
 * Credits: https://gitlab.gnome.org/GNOME/polari/-/merge_requests/134
 */

const Cairo = imports.cairo;

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const WebKit2 = imports.gi.WebKit2;


const PREVIEW_WIDTH = 120;
const PREVIEW_HEIGHT = 90;
const PREVIEW_SCRIPT = `
    const img = document.images[0];
    document.contentType.startsWith('image')
        ? [img.x, img.y, img.width, img.height]
        : null;
`;


let PreviewWindow = GObject.registerClass({
    Properties: {
        'uri': GObject.ParamSpec.string(
            'uri', 'uri', 'uri',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            null),
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

        this._view.connect('authenticate', this._onAuthenticate);
        this._view.connect('load-changed', this._onLoadChanged.bind(this));
        this._view.connect('load-failed', this._onLoadFailed.bind(this));
        this._view.load_uri(this.uri);
        this.realize();

        // Timeout after 60 seconds
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            this._onLoadTimeout.bind(this)
        );
    }

    _onAuthenticate(view, request) {
        request.cancel();
        return true;
    }

    // We use ::load-changed to ensure ::load-failed has been emitted before
    // we try to create a snapshot
    _onLoadChanged(view, event) {
        if (event !== WebKit2.LoadEvent.FINISHED)
            return;

        if (this._timeoutId > 0) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (this._loadError !== undefined) {
            this._reject(this._loadError);
            return;
        }

        /* Hopefully wait long enough for a meaningful snapshot,
           see https://bugs.webkit.org/show_bug.cgi?id=164180 */
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._resolve(this._createSnapshot());
            return GLib.SOURCE_REMOVE;
        });
    }

    _onLoadFailed(view, event, uri, error) {
        this._loadError = error;
    }

    _onLoadTimeout() {
        this._timeoutId = 0;
        this._view.stop_loading();

        return GLib.SOURCE_REMOVE;
    }

    async _createSnapshot() {
        if (this._loadError !== undefined)
            throw this._loadError;

        let clip = await this._getImageClip();

        let snapshot = await new Promise((resolve, reject) => {
            this._view.get_snapshot(
                WebKit2.SnapshotRegion.VISIBLE,
                WebKit2.SnapshotOptions.NONE,
                null,
                (view, res) => {
                    try {
                        resolve(view.get_snapshot_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        return this._createClippedSurface(snapshot, clip);
    }

    async _getImageClip() {
        let obj = null;

        try {
            obj = await new Promise((resolve, reject) => {
                this._view.run_javascript(PREVIEW_SCRIPT, null, (view, res) => {
                    try {
                        let jsResult = view.run_javascript_finish(res);
                        resolve(jsResult.get_js_value());
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } catch (e) {
            log(`Failed to get clip information: ${e} (${e.code})`);
        }

        if (obj === null || obj.is_null())
            return null;

        debug(`OUTPUT: ${obj.to_string()}`);

        let [x, y, width, height] = obj.object_enumerate_properties()
            .map(p => obj.object_get_property(p).to_int32());

        if (width === 0 || height === 0)
            throw new RangeError('Invalid image clip');

        return {x, y, width, height};
    }

    _createClippedSurface(source, clip) {
        if (clip === null)
            return source;

        let {x, y, width, height} = clip;

        let surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);

        let cr = new Cairo.Context(surface);
        cr.setSourceSurface(source, -x, -y);
        cr.paint();
        cr.$dispose();

        return surface;
    }

    getSnapshot(uri) {
        this._task = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });

        //this._view.load_uri(this.uri);

        return this._task;
    }
});

var Task = class {
    constructor(url, filename) {
        this._uri = url;
        this._filename = filename;
    }

    async run() {
        let window;

        try {
            window = new PreviewWindow({
                uri: this._uri,
                default_width: 10 * PREVIEW_WIDTH,
                default_height: 10 * PREVIEW_HEIGHT,
            });

            let surface = await window.getSnapshot();
            let title = window.title || this._uri;
            window.destroy();

            return this._saveThumbnail(surface, title);
        } catch (e) {
            window.destroy();

            throw e;
        }
    }

    async _saveThumbnail(surface, title) {
        if (!surface)
            throw Error('no snapshot');

        // Calculate the size and aspect ratio
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

        // Draw a scaled down version to a new surface
        let target = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            targetWidth,
            targetHeight);

        let cr = new Cairo.Context(target);
        cr.scale(targetWidth / sourceWidth, targetHeight / sourceHeight);
        cr.setSourceSurface(surface, 0, 0);
        cr.paint();
        cr.$dispose();

        // Open a file
        let file = Gio.File.new_for_path(this._filename);

        let stream = await new Promise((resolve, reject) => {
            file.replace_async(null, false, 0, 0, null, (file, res) => {
                try {
                    resolve(file.replace_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        // Save the pixbuf
        let pixbuf = Gdk.pixbuf_get_from_surface(
            target,
            0,
            0,
            targetWidth,
            targetHeight
        );

        return new Promise((resolve, reject) => {
            pixbuf.save_to_streamv_async(
                stream,
                'png',
                ['tEXt::Title'], [title],
                null,
                (pixbuf, res) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
};

