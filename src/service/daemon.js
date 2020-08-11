#!/usr/bin/env gjs

'use strict';

imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GdkPixbuf = '2.0';
imports.gi.versions.Gio = '2.0';
imports.gi.versions.GIRepository = '2.0';
imports.gi.versions.GLib = '2.0';
imports.gi.versions.GObject = '2.0';
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Pango = '1.0';
imports.gi.versions.UPowerGlib = '1.0';

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Find the root datadir of the extension
function get_datadir() {
    let m = /@(.+):\d+/.exec((new Error()).stack.split('\n')[1]);
    return Gio.File.new_for_path(m[1]).get_parent().get_parent().get_path();
}

globalThis.gsconnect = {extdatadir: get_datadir()};
imports.searchPath.unshift(gsconnect.extdatadir);
imports._gsconnect;

// Local Imports
const Core = imports.service.protocol.core;
const Device = imports.service.device;
const ServiceUI = imports.service.ui.service;

const _GITHUB = 'https://github.com/andyholmes/gnome-shell-extension-gsconnect';


const Service = GObject.registerClass({
    GTypeName: 'GSConnectService',
    Properties: {
        'discoverable': GObject.ParamSpec.boolean(
            'discoverable',
            'Discoverable',
            'Whether the service responds to discovery requests',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'Id',
            'The hostname or other network unique id',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The name announced to the network',
            GObject.ParamFlags.READWRITE,
            'GSConnect'
        )
    }
}, class Service extends Gtk.Application {

    _init() {
        super._init({
            application_id: 'org.gnome.Shell.Extensions.GSConnect',
            flags: Gio.ApplicationFlags.HANDLES_OPEN,
            resource_base_path: '/org/gnome/Shell/Extensions/GSConnect'
        });

        GLib.set_prgname('GSConnect');
        GLib.set_application_name('GSConnect');
        
        // Command-line
        this._initOptions();
    }

    get backends() {
        if (this._backends === undefined)
            this._backends = new Map();

        return this._backends;
    }

    get components() {
        if (this._components === undefined)
            this._components = new Map();

        return this._components;
    }

    get devices() {
        if (this._devices === undefined)
            this._devices = new Map();

        return this._devices;
    }

    get discoverable() {
        if (this._discoverable === undefined)
            this._discoverable = this.settings.get_boolean('discoverable');

        return this._discoverable;
    }

    set discoverable(value) {
        if (this.discoverable === value)
            return;

        this._discoverable = value;
        this.notify('discoverable');

        if (this.discoverable) {
            super.withdraw_notification('discovery-warning');
        } else {
            let notif = new Gio.Notification();
            notif.set_title(_('Discovery Disabled'));
            notif.set_body(_('Discovery has been disabled due to the number of devices on this network.'));
            notif.set_icon(new Gio.ThemedIcon({name: 'dialog-warning'}));
            notif.set_priority(Gio.NotificationPriority.HIGH);
            notif.set_default_action('app.preferences');

            super.send_notification('discovery-warning', notif);
        }
    }

    get id() {
        if (this._id === undefined)
            this._id = this.settings.get_string('id');

        return this._id;
    }

    set id(value) {
        if (this.id === value)
            return;

        this._id = value;
        this.notify('id');
    }

    get identity() {
        if (this._identity === undefined) {
            this._identity = new Core.Packet({
                id: 0,
                type: 'kdeconnect.identity',
                body: {
                    deviceId: this.id,
                    deviceName: this.name,
                    deviceType: this._getDeviceType(),
                    protocolVersion: 7,
                    incomingCapabilities: [],
                    outgoingCapabilities: []
                }
            });

            for (let name in imports.service.plugins) {
                // Exclude mousepad/presenter capability in unsupported sessions
                if (!HAVE_REMOTEINPUT && ['mousepad', 'presenter'].includes(name))
                    continue;

                let meta = imports.service.plugins[name].Metadata;

                meta.incomingCapabilities.map(type => {
                    this._identity.body.incomingCapabilities.push(type);
                });

                meta.outgoingCapabilities.map(type => {
                    this._identity.body.outgoingCapabilities.push(type);
                });
            }
        }

        return this._identity;
    }

    get name() {
        if (this._name === undefined)
            this._name = this.settings.get_string('name');

        return this._name;
    }

    set name(value) {
        if (this.name === value)
            return;

        this._name = value;
        this.notify('name');

        // Broadcast changes to the network
        this.identity.body.deviceName = this.name;
        this._identify();
    }

    /**
     * Helpers
     */
    _getDeviceType() {
        try {
            let type = GLib.file_get_contents('/sys/class/dmi/id/chassis_type')[1];

            type = Number(imports.byteArray.toString(type));

            if ([8, 9, 10, 14].includes(type))
                return 'laptop';

            return 'desktop';
        } catch (e) {
            return 'desktop';
        }
    }

    /**
     * Return a device for @packet, creating it and adding it to the list of
     * of known devices if it doesn't exist.
     *
     * @param {Core.Packet} packet - An identity packet for the device
     * @return {Device.Device} A device object
     */
    _ensureDevice(packet) {
        let device = this.devices.get(packet.body.deviceId);

        if (device === undefined) {
            debug(`Adding ${packet.body.deviceName}`);

            // TODO: Remove when all clients support bluetooth-like discovery
            //
            // If this is the third unpaired device to connect, we disable
            // discovery to avoid choking on networks with many devices
            let unpaired = Array.from(this.devices.values()).filter(dev => {
                return !dev.paired;
            });

            if (unpaired.length === 3)
                this.discoverable = false;

            device = new Device.Device(packet);
            this.devices.set(device.id, device);

            // Notify
            this.settings.set_strv('devices', Array.from(this.devices.keys()));
        }

        return device;
    }

    /**
     * Permanently remove a device.
     *
     * Removes the device from the list of known devices, deletes all GSettings
     * and files.
     *
     * @param {string} id - The id of the device to delete
     */
    _removeDevice(id) {
        // Delete all GSettings
        let settings_path = `/org/gnome/shell/extensions/gsconnect/${id}/`;
        GLib.spawn_command_line_async(`dconf reset -f ${settings_path}`);

        // Delete the cache
        let cache = GLib.build_filenamev([gsconnect.cachedir, id]);
        Gio.File.rm_rf(cache);

        // Forget the device
        this.devices.delete(id);
        this.settings.set_strv('devices', Array.from(this.devices.keys()));
    }

    /*
     * GSettings
     */
    _initSettings() {
        this.settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(this.application_id, true)
        });

        // Bound Properties
        this.settings.bind('discoverable', this, 'discoverable', 0);
        this.settings.bind('id', this, 'id', 0);
        this.settings.bind('name', this, 'name', 0);

        // Set the default name to the computer's hostname
        if (this.name.length === 0)
            this.settings.set_string('name', GLib.get_host_name());
    }

    /*
     * GActions
     */
    _initActions() {
        let actions = [
            ['connect', this._identify.bind(this), 's'],
            ['device', this._device.bind(this), '(ssbv)'],
            ['error', this._error.bind(this), 'a{ss}'],
            ['preferences', this._preferences],
            ['quit', () => this.quit()],
            ['refresh', this._identify.bind(this)],
            ['wiki', this._wiki.bind(this), 's']
        ];

        for (let [name, callback, type] of actions) {
            let action = new Gio.SimpleAction({
                name: name,
                parameter_type: (type) ? new GLib.VariantType(type) : null
            });
            action.connect('activate', callback);
            this.add_action(action);
        }
    }

    /**
     * A wrapper for Device GActions. This is used to route device notification
     * actions to their device, since GNotifications need an 'app' level action.
     *
     * @param {Gio.Action} action - ...
     * @param {GLib.Variant(av)} parameter - ...
     * @param {GLib.Variant(s)} parameter[0] - Device Id or '*' for all
     * @param {GLib.Variant(s)} parameter[1] - GAction name
     * @param {GLib.Variant(b)} parameter[2] - %false if the parameter is null
     * @param {GLib.Variant(v)} parameter[3] - GAction parameter
     */
    _device(action, parameter) {
        try {
            parameter = parameter.unpack();

            // Select the appropriate device(s)
            let devices;
            let id = parameter[0].unpack();

            if (id === '*')
                devices = this.devices.values();
            else
                devices = [this.devices.get(id)];

            // Unpack the action data and activate the action
            let name = parameter[1].unpack();
            let target = parameter[2].unpack() ? parameter[3].unpack() : null;

            for (let device of devices)
                device.activate_action(name, target);
        } catch (e) {
            logError(e);
        }
    }

    _error(action, parameter) {
        try {
            let error = parameter.deepUnpack();
            let dialog = new Gtk.MessageDialog({
                text: error.message,
                secondary_text: error.stack,
                buttons: Gtk.ButtonsType.CLOSE,
                message_type: Gtk.MessageType.ERROR,
            });
            dialog.add_button(_('Report'), Gtk.ResponseType.OK);
            dialog.set_keep_above(true);

            let [message, stack] = dialog.get_message_area().get_children();
            message.halign = Gtk.Align.START;
            message.selectable = true;
            stack.selectable = true;

            dialog.connect('response', (dialog, response_id) => {
                if (response_id === Gtk.ResponseType.OK) {
                    let query = encodeURIComponent(dialog.text).replace('%20', '+');
                    this._github(`issues?q=is%3Aissue+"${query}"`);
                } else {
                    dialog.destroy();
                }
            });

            dialog.show();
        } catch (e) {
            logError(e);
        }
    }

    _identify(action, parameter) {
        try {
            // If we're passed a parameter, try and find a backend for it
            if (parameter instanceof GLib.Variant) {
                let uri = parameter.unpack();
                let [scheme, address] = uri.split('://');

                let backend = this.backends.get(scheme);

                if (backend !== undefined)
                    backend.broadcast(address);

            // If we're not discoverable, only try to reconnect known devices
            } else if (!this.discoverable) {
                this._reconnect();

            // Otherwise have each backend broadcast to it's network
            } else {
                this.backends.forEach((backend) => backend.broadcast());
            }
        } catch (e) {
            logError(e);
        }
    }

    _preferences() {
        Gio.Subprocess.new([`${gsconnect.extdatadir}/gsconnect-preferences`], 0);
    }

    /**
     * A GSourceFunc that tries to reconnect to each paired device, while
     * pruning unpaired devices that have disconnected.
     */
    _reconnect() {
        for (let [id, device] of this.devices) {
            switch (true) {
                case device.connected:
                    break;

                case device.paired:
                    device.activate();
                    break;

                default:
                    this._removeDevice(id);
                    device.destroy();
            }
        }

        return GLib.SOURCE_CONTINUE;
    }

    _wiki(action, parameter) {
        this._github(`wiki/${parameter.unpack()}`);
    }

    _github(path = []) {
        let uri = [_GITHUB].concat(path.split('/')).join('/');
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    /*
     * Components
     */
    _initComponents() {
        for (let name in imports.service.components) {
            try {
                let module = imports.service.components[name];

                if (module.hasOwnProperty('Component')) {
                    let component = new module.Component();
                    this.components.set(name, component);
                }
            } catch (e) {
                logError(e, `'${name}' Component`);
            }
        }
    }

    /*
     * Backends
     */
    _onChannel(backend, channel) {
        try {
            let device = this.devices.get(channel.identity.body.deviceId);

            switch (true) {
                // Proceed if this is an existing device...
                case (device !== undefined):
                    break;

                // Or the service is discoverable...
                case this.discoverable:
                    device = this._ensureDevice(channel.identity);
                    break;

                // ...otherwise bail
                default:
                    debug(`${channel.identity.body.deviceName}: not allowed`);
                    return false;
            }

            device.setChannel(channel);
            return true;
        } catch (e) {
            logError(e, backend.name);
            return false;
        }
    }

    _initBackends() {
        let backends = [
            'bluetooth',
            'lan'
        ];

        for (let name of backends) {
            try {
                // Try to create the backend and track it if successful
                let module = imports.service.protocol[name];
                let backend = new module.ChannelService();
                this.backends.set(name, backend);

                // Connect to the backend
                backend.__channelId = backend.connect(
                    'channel',
                    this._onChannel.bind(this)
                );

                // Now try to start the backend, allowing us to retry if we fail
                backend.start();
            } catch (e) {
                this.notify_error(e);
            }
        }
    }

    /**
     * Report a service-level error
     *
     * @param {Object} error - An Error or object with name, message and stack
     */
    notify_error(error) {
        try {
            // Always log the error
            logError(error);

            // Create an new notification
            let id, title, body, icon, priority;
            let notif = new Gio.Notification();

            switch (error.name) {
                case 'LanError':
                    id = error.name;
                    title = _('Network Error');
                    body = _('Click for help troubleshooting');
                    icon = new Gio.ThemedIcon({name: 'network-error'});
                    priority = Gio.NotificationPriority.URGENT;
                    notif.set_default_action(`app.wiki('Help#${error.name}')`);
                    break;

                default:
                    id = `${Date.now()}`;
                    title = error.name.trim();
                    body = _('Click for more information');
                    icon = new Gio.ThemedIcon({name: 'dialog-error'});
                    error = new GLib.Variant('a{ss}', {
                        name: error.name.trim(),
                        message: error.message.trim(),
                        stack: error.stack.trim()
                    });
                    notif.set_default_action_and_target('app.error', error);
                    priority = Gio.NotificationPriority.HIGH;
            }

            // Create an urgent notification
            notif.set_title(`GSConnect: ${title}`);
            notif.set_body(body);
            notif.set_icon(icon);
            notif.set_priority(priority);

            // Bypass override
            super.send_notification(id, notif);
        } catch (e) {
            logError(e);
        }
    }

    vfunc_activate() {
        super.vfunc_activate();
    }

    vfunc_startup() {
        super.vfunc_startup();

        this.hold();

        // Watch *this* file and stop the service if it's updated/uninstalled
        this._serviceMonitor = Gio.File.new_for_path(
            `${gsconnect.extdatadir}/service/daemon.js`
        ).monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._serviceMonitor.connect('changed', () => this.quit());

        // Init some resources
        let provider = new Gtk.CssProvider();
        provider.load_from_resource(`${this.resource_base_path}/application.css`);
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // Ensure our handlers are registered
        try {
            let appInfo = Gio.DesktopAppInfo.new(`${this.application_id}.desktop`);
            appInfo.add_supports_type('x-scheme-handler/sms');
            appInfo.add_supports_type('x-scheme-handler/tel');
        } catch (e) {
            logError(e);
        }

        // GActions & GSettings
        this._initSettings();
        this._initActions();
        this._initComponents();
        this._initBackends();

        // Load cached devices
        for (let id of this.settings.get_strv('devices'))
            this.devices.set(id, new Device.Device({body: {deviceId: id}}));

        // Reconnect to paired devices every 5 seconds
        GLib.timeout_add_seconds(300, 5, this._reconnect.bind(this));
    }

    vfunc_dbus_register(connection, object_path) {
        if (!super.vfunc_dbus_register(connection, object_path))
            return false;

        this.objectManager = new Gio.DBusObjectManagerServer({
            connection: connection,
            object_path: object_path
        });
        
        return true;
    }

    vfunc_open(files, hint) {
        super.vfunc_open(files, hint);

        for (let file of files) {
            let action, parameter, title;

            try {
                switch (file.get_uri_scheme()) {
                    case 'sms':
                        title = _('Send SMS');
                        action = 'uriSms';
                        parameter = new GLib.Variant('s', file.get_uri());
                        break;

                    case 'tel':
                        title = _('Dial Number');
                        action = 'shareUri';
                        parameter = new GLib.Variant('s', file.get_uri());
                        break;

                    case 'file':
                        title = _('Share File');
                        action = 'shareFile';
                        parameter = new GLib.Variant('(sb)', [file.get_uri(), false]);
                        break;

                    default:
                        throw new Error(`Unsupported URI: ${file.get_uri()}`);
                }

                // Show chooser dialog
                new ServiceUI.DeviceChooser({
                    title: title,
                    action_name: action,
                    action_target: parameter
                });
            } catch (e) {
                logError(e, `GSConnect: Opening ${file.get_uri()}`);
            }
        }
    }

    vfunc_shutdown() {
        // Dispose GSettings
        this.settings.run_dispose();

        // Destroy the backends first to avoid any further connections
        this.backends.forEach((backend) => backend.destroy());
        this.backends.clear();

        // We must unexport the devices before ::dbus-unregister is emitted and
        // exhaust the main loop to ensure connections are properly closed.
        this.devices.forEach(device => device.destroy());
        this.devices.clear();

        let context = GLib.MainContext.default();

        while (context.iteration(false))
            continue;

        // Destroy the components now that device plugins aren't using them
        this.components.forEach((component) => component.destroy());
        this.components.clear();

        // Force a GC to prevent any more calls back into JS, then chain-up
        imports.system.gc();
        super.vfunc_shutdown();
    }
    
    /*
     * CLI
     */
    _initOptions() {
        /*
         * Device Listings
         */
        this.add_main_option(
            'list-devices',
            'l'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List available devices'),
            null
        );
        
        this.add_main_option(
            'list-all',
            'a'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('List all devices'),
            null
        );
        
        this.add_main_option(
            'device',
            'd'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Target Device'),
            '<device-id>'
        );

        /**
         * Pairing
         */
        this.add_main_option(
            'pair',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Pair'),
            null
        );

        this.add_main_option(
            'unpair',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Unpair'),
            null
        );

        /*
         * Messaging
         */
        this.add_main_option(
            'message',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING_ARRAY,
            _('Send SMS'),
            '<phone-number>'
        );
        
        this.add_main_option(
            'message-body',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Message Body'),
            '<text>'
        );

        /*
         * Notifications
         */
        this.add_main_option(
            'notification',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Send Notification'),
            '<title>'
        );
        
        this.add_main_option(
            'notification-appname',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification App Name'),
            '<name>'
        );

        this.add_main_option(
            'notification-body',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification Body'),
            '<text>'
        );

        this.add_main_option(
            'notification-icon',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification Icon'),
            '<icon-name>'
        );

        this.add_main_option(
            'notification-id',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Notification ID'),
            '<id>'
        );

        this.add_main_option(
            'photo',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Photo'),
            null
        );
        
        this.add_main_option(
            'ping',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ping'),
            null
        );
        
        this.add_main_option(
            'ring',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Ring'),
            null
        );

        /*
         * Sharing
         */
        this.add_main_option(
            'share-file',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.FILENAME_ARRAY,
            _('Share File'),
            '<filepath|URI>'
        );

        this.add_main_option(
            'share-link',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING_ARRAY,
            _('Share Link'),
            '<URL>'
        );

        this.add_main_option(
            'share-text',
            0,
            GLib.OptionFlags.NONE,
            GLib.OptionArg.STRING,
            _('Share Text'),
            '<text>'
        );
        
        /*
         * Misc
         */
        this.add_main_option(
            'version',
            'v'.charCodeAt(0),
            GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE,
            _('Show release version'),
            null
        );
    }

    _cliAction(id, name, parameter = null) {
        let parameters = [];

        if (parameter instanceof GLib.Variant)
            parameters[0] = parameter;

        id = id.replace(/\W+/g, '_');

        Gio.DBus.session.call_sync(
            'org.gnome.Shell.Extensions.GSConnect',
            `/org/gnome/Shell/Extensions/GSConnect/Device/${id}`,
            'org.gtk.Actions',
            'Activate',
            GLib.Variant.new('(sava{sv})', [name, parameters, {}]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
    }
    
    _cliListDevices(full = true) {
        let result = Gio.DBus.session.call_sync(
            'org.gnome.Shell.Extensions.GSConnect',
            '/org/gnome/Shell/Extensions/GSConnect',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );

        let variant = result.unpack()[0].unpack();
        let device;

        for (let object of Object.values(variant)) {
            object = object.recursiveUnpack();
            device = object['org.gnome.Shell.Extensions.GSConnect.Device'];
            
            if (full)
                print(`${device.Id}\t${device.Name}\t${device.Connected}\t${device.Paired}`);
            else if (device.Connected && device.Paired)
                print(device.Id);
        }
    }

    _cliMessage(id, options) {
        if (!options.contains('message-body'))
            throw new TypeError('missing --message-body option');

        // TODO: currently we only support single-recipient messaging
        let addresses = options.lookup_value('message', null).deepUnpack();
        let body = options.lookup_value('message-body', null).deepUnpack();

        this._cliAction(
            id,
            'sendSms',
            GLib.Variant.new('(ss)', [addresses[0], body])
        );
    }

    _cliNotify(id, options) {
        let title = options.lookup_value('notification', null).unpack();
        let body = '';
        let icon = null;
        let nid = `${Date.now()}`;
        let appName = gsconnect.settings.get_string('name');

        if (options.contains('notification-id'))
            nid = options.lookup_value('notification-id', null).unpack();

        if (options.contains('notification-body'))
            body = options.lookup_value('notification-body', null).unpack();

        if (options.contains('notification-appname'))
            appName = options.lookup_value('notification-appname', null).unpack();

        if (options.contains('notification-icon')) {
            icon = options.lookup_value('notification-icon', null).unpack();
            icon = Gio.Icon.new_for_string(icon);
        } else {
            icon = new Gio.ThemedIcon({
                name: 'org.gnome.Shell.Extensions.GSConnect'
            });
        }

        let notification = new GLib.Variant('a{sv}', {
            appName: GLib.Variant.new_string(appName),
            id: GLib.Variant.new_string(nid),
            title: GLib.Variant.new_string(title),
            text: GLib.Variant.new_string(body),
            ticker: GLib.Variant.new_string(`${title}: ${body}`),
            time: GLib.Variant.new_string(`${Date.now()}`),
            isClearable: GLib.Variant.new_boolean(true),
            icon: icon.serialize()
        });

        this._cliAction(id, 'sendNotification', notification);
    }
    
    _cliShareFile(device, options) {
        let files = options.lookup_value('share-file', null).deepUnpack();

        files.map(file => {
            file = imports.byteArray.toString(file);

            this._cliAction(device, 'shareFile', GLib.Variant.new('(sb)', [file, false]));
        });
    }

    _cliShareLink(device, options) {
        let uris = options.lookup_value('share-link', null).deepUnpack();

        uris.map(uri => {
            uri = imports.byteArray.toString(uri);
            
            this._cliAction(device, 'shareUri', GLib.Variant.new_string(uri));
        });
    }

    _cliShareText(device, options) {
        let text = options.lookup_value('share-text', null).unpack();

        this._cliAction(device, 'shareText', GLib.Variant.new_string(text));
    }

    vfunc_handle_local_options(options) {
        try {
            if (options.contains('version')) {
                print(`GSConnect ${gsconnect.metadata.version}`);
                return 0;
            }

            this.register(null);

            if (options.contains('list-devices')) {
                this._cliListDevices(false);
                return 0;
            }

            if (options.contains('list-all')) {
                this._cliListDevices(true);
                return 0;
            }

            // We need a device for anything else; exit since this is probably
            // the daemon being started.
            if (!options.contains('device'))
                return -1;

            let id = options.lookup_value('device', null).unpack();

            // Pairing
            if (options.contains('pair')) {
                this._cliAction(id, 'pair');
                return 0;
            }

            if (options.contains('unpair')) {
                this._cliAction(id, 'unpair');
                return 0;
            }

            // Plugins
            if (options.contains('message'))
                this._cliMessage(id, options);

            if (options.contains('notification'))
                this._cliNotify(id, options);

            if (options.contains('photo'))
                this._cliAction(id, 'photo');

            if (options.contains('ping'))
                this._cliAction(id, 'ping', GLib.Variant.new_string(''));

            if (options.contains('ring'))
                this._cliAction(id, 'ring');

            if (options.contains('share-file'))
                this._cliShareFile(id, options);

            if (options.contains('share-link'))
                this._cliShareLink(id, options);

            if (options.contains('share-text'))
                this._cliShareLink(id, options);

            return 0;
        } catch (e) {
            logError(e);
            return 1;
        }
    }
});

(new Service()).run([imports.system.programInvocationName].concat(ARGV));

