'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Config = imports.config;
const Components = imports.service.components;
const Core = imports.service.core;


/**
 * An object representing a remote device.
 *
 * Device class is subclassed from Gio.SimpleActionGroup so it implements the
 * GActionGroup and GActionMap interfaces, like Gio.Application.
 *
 */
var Device = GObject.registerClass({
    GTypeName: 'GSConnectDevice',
    Properties: {
        'connected': GObject.ParamSpec.boolean(
            'connected',
            'Connected',
            'Whether the device is connected',
            GObject.ParamFlags.READABLE,
            false
        ),
        'contacts': GObject.ParamSpec.object(
            'contacts',
            'Contacts',
            'The contacts store for this device',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'encryption-info': GObject.ParamSpec.string(
            'encryption-info',
            'Encryption Info',
            'A formatted string with the local and remote fingerprints',
            GObject.ParamFlags.READABLE,
            null
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'Icon Name',
            'Icon name representing the device',
            GObject.ParamFlags.READABLE,
            null
        ),
        'id': GObject.ParamSpec.string(
            'id',
            'Id',
            'The device hostname or other network unique id',
            GObject.ParamFlags.READABLE,
            ''
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The device name',
            GObject.ParamFlags.READABLE,
            null
        ),
        'paired': GObject.ParamSpec.boolean(
            'paired',
            'Paired',
            'Whether the device is paired',
            GObject.ParamFlags.READABLE,
            false
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'Type',
            'The device type',
            GObject.ParamFlags.READABLE,
            null
        ),
    },
}, class Device extends Gio.SimpleActionGroup {

    _init(identity) {
        super._init();

        this._id = identity.body.deviceId;

        // GLib.Source timeout id's for pairing requests
        this._incomingPairRequest = 0;
        this._outgoingPairRequest = 0;

        // Maps of name->Plugin, packet->Plugin, uuid->Transfer
        this._plugins = new Map();
        this._handlers = new Map();
        this._procs = new Set();
        this._transfers = new Map();

        this._outputLock = false;
        this._outputQueue = [];

        // GSettings
        this.settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect.Device',
                true
            ),
            path: `/org/gnome/shell/extensions/gsconnect/device/${this.id}/`,
        });

        // Watch for changes to supported and disabled plugins
        this._disabledPluginsChangedId = this.settings.connect(
            'changed::disabled-plugins',
            this._onAllowedPluginsChanged.bind(this)
        );
        this._supportedPluginsChangedId = this.settings.connect(
            'changed::supported-plugins',
            this._onAllowedPluginsChanged.bind(this)
        );

        this._registerActions();
        this.menu = new Gio.Menu();

        // Parse identity if initialized with a proper packet, otherwise load
        if (identity.id !== undefined)
            this._handleIdentity(identity);
        else
            this._loadPlugins();
    }

    get channel() {
        if (this._channel === undefined)
            this._channel = null;

        return this._channel;
    }

    get connected() {
        if (this._connected === undefined)
            this._connected = false;

        return this._connected;
    }

    get connection_type() {
        const lastConnection = this.settings.get_string('last-connection');

        return lastConnection.split('://')[0];
    }

    get contacts() {
        const contacts = this._plugins.get('contacts');

        if (contacts && contacts.settings.get_boolean('contacts-source'))
            return contacts._store;

        if (this._contacts === undefined)
            this._contacts = Components.acquire('contacts');

        return this._contacts;
    }

    // FIXME: backend should do this stuff
    get encryption_info() {
        let remoteFingerprint = _('Not available');
        let localFingerprint = _('Not available');

        // Bluetooth connections have no certificate so we use the host address
        if (this.connection_type === 'bluetooth') {
            // TRANSLATORS: Bluetooth address for remote device
            return _('Bluetooth device at %s').format('???');

        // If the device is connected use the certificate from the connection
        } else if (this.connected) {
            remoteFingerprint = this.channel.peer_certificate.fingerprint();

        // Otherwise pull it out of the settings
        } else if (this.paired) {
            remoteFingerprint = Gio.TlsCertificate.new_from_pem(
                this.settings.get_string('certificate-pem'),
                -1
            ).fingerprint();
        }

        // FIXME: another ugly reach-around
        let lanBackend;

        if (this.service !== null)
            lanBackend = this.service.manager.backends.get('lan');

        if (lanBackend && lanBackend.certificate)
            localFingerprint = lanBackend.certificate.fingerprint();

        // TRANSLATORS: Label for TLS Certificate fingerprint
        //
        // Example:
        //
        // Google Pixel Fingerprint:
        // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
        return _('%s Fingerprint:').format(this.name) + '\n' +
            remoteFingerprint + '\n\n' +
            _('%s Fingerprint:').format('GSConnect') + '\n' +
            localFingerprint;
    }

    get id() {
        return this._id;
    }

    get name() {
        return this.settings.get_string('name');
    }

    get paired() {
        return this.settings.get_boolean('paired');
    }

    get icon_name() {
        switch (this.type) {
            case 'laptop':
                return 'laptop-symbolic';
            case 'phone':
                return 'smartphone-symbolic';
            case 'tablet':
                return 'tablet-symbolic';
            case 'tv':
                return 'tv-symbolic';
            case 'desktop':
            default:
                return 'computer-symbolic';
        }
    }

    get service() {
        if (this._service === undefined)
            this._service = Gio.Application.get_default();

        return this._service;
    }

    get type() {
        return this.settings.get_string('type');
    }

    _handleIdentity(packet) {
        this.freeze_notify();

        // If we're connected, record the reconnect URI
        if (this.channel !== null)
            this.settings.set_string('last-connection', this.channel.address);

        // The type won't change, but it might not be properly set yet
        if (this.type !== packet.body.deviceType) {
            this.settings.set_string('type', packet.body.deviceType);
            this.notify('type');
            this.notify('icon-name');
        }

        // The name may change so we check and notify if so
        if (this.name !== packet.body.deviceName) {
            this.settings.set_string('name', packet.body.deviceName);
            this.notify('name');
        }

        // Packets
        const incoming = packet.body.incomingCapabilities.sort();
        const outgoing = packet.body.outgoingCapabilities.sort();
        const inc = this.settings.get_strv('incoming-capabilities');
        const out = this.settings.get_strv('outgoing-capabilities');

        // Only write GSettings if something has changed
        if (incoming.join('') !== inc.join('') || outgoing.join('') !== out.join('')) {
            this.settings.set_strv('incoming-capabilities', incoming);
            this.settings.set_strv('outgoing-capabilities', outgoing);
        }

        // Determine supported plugins by matching incoming to outgoing types
        const supported = [];

        for (const name in imports.service.plugins) {
            // Exclude mousepad/presenter plugins in unsupported sessions
            if (!HAVE_REMOTEINPUT && ['mousepad', 'presenter'].includes(name))
                continue;

            const meta = imports.service.plugins[name].Metadata;

            // If we can handle packets it sends or send packets it can handle
            if (meta.incomingCapabilities.some(t => outgoing.includes(t)) ||
                meta.outgoingCapabilities.some(t => incoming.includes(t)))
                supported.push(name);
        }

        // Only write GSettings if something has changed
        const currentSupported = this.settings.get_strv('supported-plugins');

        if (currentSupported.join('') !== supported.sort().join(''))
            this.settings.set_strv('supported-plugins', supported);

        this.thaw_notify();
    }

    /**
     * Set the channel and start sending/receiving packets. If %null is passed
     * the device becomes disconnected.
     *
     * @param {Core.Channel} [channel] - The new channel
     */
    setChannel(channel = null) {
        if (this.channel === channel)
            return;

        if (this.channel !== null)
            this.channel.close();

        this._channel = channel;

        // If we've disconnected empty the queue, otherwise restart the read
        // loop and update the device metadata
        if (this.channel === null) {
            this._outputQueue.length = 0;
        } else {
            this._handleIdentity(this.channel.identity);
            this._readLoop(channel);
        }

        // The connected state didn't change
        if (this.connected === !!this.channel)
            return;

        // Notify and trigger plugins
        this._connected = !!this.channel;
        this.notify('connected');
        this._triggerPlugins();
    }

    async _readLoop(channel) {
        try {
            let packet = null;

            while ((packet = await this.channel.readPacket())) {
                debug(packet, this.name);
                this.handlePacket(packet);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.name);

            if (this.channel === channel)
                this.setChannel(null);
        }
    }

    _processExit(proc, result) {
        try {
            proc.wait_check_finish(result);
        } catch (e) {
            debug(e);
        }

        this.delete(proc);
    }

    /**
     * Launch a subprocess for the device. If the device becomes unpaired, it is
     * assumed the device is no longer trusted and all subprocesses will be
     * killed.
     *
     * @param {string[]} args - process arguments
     * @param {Gio.Cancellable} [cancellable] - optional cancellable
     * @return {Gio.Subprocess} The subprocess
     */
    launchProcess(args, cancellable = null) {
        if (this._launcher === undefined) {
            const application = GLib.build_filenamev([
                Config.PACKAGE_DATADIR,
                'service',
                'daemon.js',
            ]);

            this._launcher = new Gio.SubprocessLauncher();
            this._launcher.setenv('GSCONNECT', application, false);
            this._launcher.setenv('GSCONNECT_DEVICE_ID', this.id, false);
            this._launcher.setenv('GSCONNECT_DEVICE_NAME', this.name, false);
            this._launcher.setenv('GSCONNECT_DEVICE_ICON', this.icon_name, false);
            this._launcher.setenv(
                'GSCONNECT_DEVICE_DBUS',
                `${Config.APP_PATH}/Device/${this.id.replace(/\W+/g, '_')}`,
                false
            );
        }

        // Create and track the process
        const proc = this._launcher.spawnv(args);
        proc.wait_check_async(cancellable, this._processExit.bind(this._procs));
        this._procs.add(proc);

        return proc;
    }

    /**
     * Handle a packet and pass it to the appropriate plugin.
     *
     * @param {Core.Packet} packet - The incoming packet object
     * @return {undefined} no return value
     */
    handlePacket(packet) {
        try {
            if (packet.type === 'kdeconnect.pair')
                return this._handlePair(packet);

            // The device must think we're paired; inform it we are not
            if (!this.paired)
                return this.unpair();

            const handler = this._handlers.get(packet.type);

            if (handler !== undefined)
                handler.handlePacket(packet);
            else
                debug(`Unsupported packet type (${packet.type})`, this.name);
        } catch (e) {
            debug(e, this.name);
        }
    }

    /**
     * Send a packet to the device.
     *
     * @param {Object} packet - An object of packet data...
     */
    async sendPacket(packet) {
        try {
            if (!this.connected)
                return;

            if (!this.paired && packet.type !== 'kdeconnect.pair')
                return;

            this._outputQueue.push(new Core.Packet(packet));

            if (this._outputLock)
                return;

            this._outputLock = true;
            let next;

            while ((next = this._outputQueue.shift())) {
                await this.channel.sendPacket(next);
                debug(next, this.name);
            }

            this._outputLock = false;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, this.name);

            this._outputLock = false;
        }
    }

    /**
     * Actions
     */
    _registerActions() {
        // Pairing notification actions
        const acceptPair = new Gio.SimpleAction({name: 'pair'});
        acceptPair.connect('activate', this.pair.bind(this));
        this.add_action(acceptPair);

        const rejectPair = new Gio.SimpleAction({name: 'unpair'});
        rejectPair.connect('activate', this.unpair.bind(this));
        this.add_action(rejectPair);

        // Transfer notification actions
        const cancelTransfer = new Gio.SimpleAction({
            name: 'cancelTransfer',
            parameter_type: new GLib.VariantType('s'),
        });
        cancelTransfer.connect('activate', this.cancelTransfer.bind(this));
        this.add_action(cancelTransfer);

        const openPath = new Gio.SimpleAction({
            name: 'openPath',
            parameter_type: new GLib.VariantType('s'),
        });
        openPath.connect('activate', this.openPath);
        this.add_action(openPath);

        const openPathSelectFile = new Gio.SimpleAction({
            name: 'openPathSelectFile',
            parameter_type: new GLib.VariantType('s'),
        });
        openPathSelectFile.connect('activate', this.openPathSelectFile);
        this.add_action(openPathSelectFile);

        // Preference helpers
        const clearCache = new Gio.SimpleAction({
            name: 'clearCache',
            parameter_type: null,
        });
        clearCache.connect('activate', this._clearCache.bind(this));
        this.add_action(clearCache);
    }

    /**
     * Get the position of a GMenuItem with @actionName in the top level of the
     * device menu.
     *
     * @param {string} actionName - An action name with scope (eg. device.foo)
     * @return {number} An 0-based index or -1 if not found
     */
    getMenuAction(actionName) {
        for (let i = 0, len = this.menu.get_n_items(); i < len; i++) {
            try {
                const val = this.menu.get_item_attribute_value(i, 'action', null);

                if (val.unpack() === actionName)
                    return i;
            } catch (e) {
                continue;
            }
        }

        return -1;
    }

    /**
     * Add a GMenuItem to the top level of the device menu
     *
     * @param {Gio.MenuItem} menuItem - A GMenuItem
     * @param {number} [index] - The position to place the item
     * @return {number} The position the item was placed
     */
    addMenuItem(menuItem, index = -1) {
        try {
            if (index > -1) {
                this.menu.insert_item(index, menuItem);
                return index;
            }

            this.menu.append_item(menuItem);
            return this.menu.get_n_items();
        } catch (e) {
            debug(e, this.name);
            return -1;
        }
    }

    /**
     * Add a Device GAction to the top level of the device menu
     *
     * @param {Gio.Action} action - A GAction
     * @param {number} [index] - The position to place the item
     * @param {string} label - A label for the item
     * @param {string} icon_name - A themed icon name for the item
     * @return {number} The position the item was placed
     */
    addMenuAction(action, index = -1, label, icon_name) {
        try {
            const item = new Gio.MenuItem();

            if (label)
                item.set_label(label);

            if (icon_name)
                item.set_icon(new Gio.ThemedIcon({name: icon_name}));

            item.set_attribute_value(
                'hidden-when',
                new GLib.Variant('s', 'action-disabled')
            );

            item.set_detailed_action(`device.${action.name}`);

            return this.addMenuItem(item, index);
        } catch (e) {
            debug(e, this.name);
            return -1;
        }
    }

    /**
     * Remove a GAction from the top level of the device menu by action name
     *
     * @param {string} actionName - A GAction name, including scope
     * @return {number} The position the item was removed from or -1
     */
    removeMenuAction(actionName) {
        try {
            const index = this.getMenuAction(actionName);

            if (index > -1)
                this.menu.remove(index);

            return index;
        } catch (e) {
            debug(e, this.name);
            return -1;
        }
    }

    /**
     * Withdraw a device notification.
     *
     * @param {string} id - Id for the notification to withdraw
     */
    hideNotification(id) {
        if (this.service === null)
            return;

        this.service.withdraw_notification(`${this.id}|${id}`);
    }

    /**
     * Show a device notification.
     *
     * @param {Object} params - A dictionary of notification parameters
     * @param {number} [params.id] - A UNIX epoch timestamp (ms)
     * @param {string} [params.title] - A title
     * @param {string} [params.body] - A body
     * @param {Gio.Icon} [params.icon] - An icon
     * @param {Gio.NotificationPriority} [params.priority] - The priority
     * @param {Array} [params.actions] - A dictionary of action parameters
     * @param {Array} [params.buttons] - An Array of buttons
     */
    showNotification(params) {
        if (this.service === null)
            return;

        // KDE Connect on Android can sometimes give an undefined for params.body
        Object.keys(params)
            .forEach(key => params[key] === undefined && delete params[key]);

        params = Object.assign({
            id: Date.now(),
            title: this.name,
            body: '',
            icon: new Gio.ThemedIcon({name: this.icon_name}),
            priority: Gio.NotificationPriority.NORMAL,
            action: null,
            buttons: [],
        }, params);

        const notif = new Gio.Notification();
        notif.set_title(params.title);
        notif.set_body(params.body);
        notif.set_icon(params.icon);
        notif.set_priority(params.priority);

        // Default Action
        if (params.action) {
            const hasParameter = (params.action.parameter !== null);

            if (!hasParameter)
                params.action.parameter = new GLib.Variant('s', '');

            notif.set_default_action_and_target(
                'app.device',
                new GLib.Variant('(ssbv)', [
                    this.id,
                    params.action.name,
                    hasParameter,
                    params.action.parameter,
                ])
            );
        }

        // Buttons
        for (const button of params.buttons) {
            const hasParameter = (button.parameter !== null);

            if (!hasParameter)
                button.parameter = new GLib.Variant('s', '');

            notif.add_button_with_target(
                button.label,
                'app.device',
                new GLib.Variant('(ssbv)', [
                    this.id,
                    button.action,
                    hasParameter,
                    button.parameter,
                ])
            );
        }

        this.service.send_notification(`${this.id}|${params.id}`, notif);
    }

    /**
     * Cancel an ongoing file transfer.
     *
     * @param {Gio.Action} action - The GAction
     * @param {GLib.Variant} parameter - The activation parameter
     */
    cancelTransfer(action, parameter) {
        try {
            const uuid = parameter.unpack();
            const transfer = this._transfers.get(uuid);

            if (transfer === undefined)
                return;

            this._transfers.delete(uuid);
            transfer.cancel();
        } catch (e) {
            logError(e, this.name);
        }
    }

    /**
     * Create a transfer object.
     *
     * @return {Core.Transfer} A new transfer
     */
    createTransfer() {
        const transfer = new Core.Transfer({device: this});

        // Track the transfer
        this._transfers.set(transfer.uuid, transfer);

        transfer.connect('notify::completed', (transfer) => {
            this._transfers.delete(transfer.uuid);
        });

        return transfer;
    }

    /**
     * Reject the transfer payload described by @packet.
     *
     * @param {Core.Packet} packet - A packet
     * @return {Promise} A promise for the operation
     */
    rejectTransfer(packet) {
        if (!packet || !packet.hasPayload())
            return;

        return this.channel.rejectTransfer(packet);
    }

    openPath(action, parameter) {
        const path = parameter.unpack();

        // Normalize paths to URIs, assuming local file
        const uri = path.includes('://') ? path : `file://${path}`;
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
    }

    openPathSelectFile(action, parameter) {
        const path = parameter.unpack();
        const uri = path.includes('://') ? path : `file://${path}`;

        Gio.DBus.session.call(
            'org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1',
            'ShowItems',
            new GLib.Variant('(ass)', [[uri], 's']),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    _clearCache(action, parameter) {
        for (const plugin of this._plugins.values()) {
            try {
                plugin.clearCache();
            } catch (e) {
                debug(e, this.name);
            }
        }
    }

    /**
     * Pair request handler
     *
     * @param {Core.Packet} packet - A complete kdeconnect.pair packet
     */
    _handlePair(packet) {
        // A pair has been requested/confirmed
        if (packet.body.pair) {
            // The device is accepting our request
            if (this._outgoingPairRequest) {
                this._setPaired(true);
                this._loadPlugins();

            // The device thinks we're unpaired
            } else if (this.paired) {
                this._setPaired(true);
                this.sendPacket({
                    type: 'kdeconnect.pair',
                    body: {pair: true},
                });
                this._triggerPlugins();

            // The device is requesting pairing
            } else {
                this._notifyPairRequest();
            }
        // Device is requesting unpairing/rejecting our request
        } else {
            this._setPaired(false);
            this._unloadPlugins();
        }
    }

    /**
     * Notify the user of an incoming pair request and set a 30s timeout
     */
    _notifyPairRequest() {
        // Reset any active request
        this._resetPairRequest();

        this.showNotification({
            id: 'pair-request',
            // TRANSLATORS: eg. Pair Request from Google Pixel
            title: _('Pair Request from %s').format(this.name),
            body: this.encryption_info,
            icon: new Gio.ThemedIcon({name: 'channel-insecure-symbolic'}),
            priority: Gio.NotificationPriority.URGENT,
            buttons: [
                {
                    action: 'unpair',
                    label: _('Reject'),
                    parameter: null,
                },
                {
                    action: 'pair',
                    label: _('Accept'),
                    parameter: null,
                },
            ],
        });

        // Start a 30s countdown
        this._incomingPairRequest = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            30,
            this._setPaired.bind(this, false)
        );
    }

    /**
     * Reset pair request timeouts and withdraw any notifications
     */
    _resetPairRequest() {
        this.hideNotification('pair-request');

        if (this._incomingPairRequest) {
            GLib.source_remove(this._incomingPairRequest);
            this._incomingPairRequest = 0;
        }

        if (this._outgoingPairRequest) {
            GLib.source_remove(this._outgoingPairRequest);
            this._outgoingPairRequest = 0;
        }
    }

    /**
     * Set the internal paired state of the device and emit ::notify
     *
     * @param {boolean} paired - The paired state to set
     */
    _setPaired(paired) {
        this._resetPairRequest();

        // For TCP connections we store or reset the TLS Certificate
        if (this.connection_type === 'lan') {
            if (paired) {
                this.settings.set_string(
                    'certificate-pem',
                    this.channel.peer_certificate.certificate_pem
                );
            } else {
                this.settings.reset('certificate-pem');
            }
        }

        // If we've become unpaired, stop all subprocesses and transfers
        if (!paired) {
            for (const proc of this._procs)
                proc.force_exit();

            this._procs.clear();

            for (const transfer of this._transfers.values())
                transfer.close();

            this._transfers.clear();
        }

        this.settings.set_boolean('paired', paired);
        this.notify('paired');
    }

    /**
     * Send or accept an incoming pair request; also exported as a GAction
     */
    pair() {
        try {
            // If we're accepting an incoming pair request, set the internal
            // paired state and send the confirmation before loading plugins.
            if (this._incomingPairRequest) {
                this._setPaired(true);

                this.sendPacket({
                    type: 'kdeconnect.pair',
                    body: {pair: true},
                });

                this._loadPlugins();

            // If we're initiating an outgoing pair request, be sure the timer
            // is reset before sending the request and setting a 30s timeout.
            } else if (!this.paired) {
                this._resetPairRequest();

                this.sendPacket({
                    type: 'kdeconnect.pair',
                    body: {pair: true},
                });

                this._outgoingPairRequest = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    30,
                    this._setPaired.bind(this, false)
                );
            }
        } catch (e) {
            logError(e, this.name);
        }
    }

    /**
     * Unpair or reject an incoming pair request; also exported as a GAction
     */
    unpair() {
        try {
            if (this.connected) {
                this.sendPacket({
                    type: 'kdeconnect.pair',
                    body: {pair: false},
                });
            }

            this._setPaired(false);
            this._unloadPlugins();
        } catch (e) {
            logError(e, this.name);
        }
    }

    /*
     * Plugin Functions
     */
    _onAllowedPluginsChanged(settings) {
        const disabled = this.settings.get_strv('disabled-plugins');
        const supported = this.settings.get_strv('supported-plugins');
        const allowed = supported.filter(name => !disabled.includes(name));

        // Unload any plugins that are disabled or unsupported
        this._plugins.forEach(plugin => {
            if (!allowed.includes(plugin.name))
                this._unloadPlugin(plugin.name);
        });

        // Make sure we change the contacts store if the plugin was disabled
        if (!allowed.includes('contacts'))
            this.notify('contacts');

        // Load allowed plugins
        for (const name of allowed)
            this._loadPlugin(name);
    }

    _loadPlugin(name) {
        let handler, plugin;

        try {
            if (this.paired && !this._plugins.has(name)) {
                // Instantiate the handler
                handler = imports.service.plugins[name];
                plugin = new handler.Plugin(this);

                // Register packet handlers
                for (const packetType of handler.Metadata.incomingCapabilities)
                    this._handlers.set(packetType, plugin);

                // Register plugin
                this._plugins.set(name, plugin);

                // Run the connected()/disconnected() handler
                if (this.connected)
                    plugin.connected();
                else
                    plugin.disconnected();
            }
        } catch (e) {
            if (plugin !== undefined)
                plugin.destroy();

            if (this.service !== null)
                this.service.notify_error(e);
            else
                logError(e, this.name);
        }
    }

    async _loadPlugins() {
        const disabled = this.settings.get_strv('disabled-plugins');

        for (const name of this.settings.get_strv('supported-plugins')) {
            if (!disabled.includes(name))
                await this._loadPlugin(name);
        }
    }

    _unloadPlugin(name) {
        let handler, plugin;

        try {
            if (this._plugins.has(name)) {
                // Unregister packet handlers
                handler = imports.service.plugins[name];

                for (const type of handler.Metadata.incomingCapabilities)
                    this._handlers.delete(type);

                // Unregister plugin
                plugin = this._plugins.get(name);
                this._plugins.delete(name);
                plugin.destroy();
            }
        } catch (e) {
            logError(e, this.name);
        }
    }

    async _unloadPlugins() {
        for (const name of this._plugins.keys())
            await this._unloadPlugin(name);
    }

    _triggerPlugins() {
        for (const plugin of this._plugins.values()) {
            if (this.connected)
                plugin.connected();
            else
                plugin.disconnected();
        }
    }

    destroy() {
        // Drop the default contacts store if we were using it
        if (this._contacts !== undefined)
            this._contacts = Components.release('contacts');

        // Close the channel if still connected
        if (this.channel !== null)
            this.channel.close();

        // Synchronously destroy plugins
        this._plugins.forEach(plugin => plugin.destroy());
        this._plugins.clear();

        // Dispose GSettings
        this.settings.disconnect(this._disabledPluginsChangedId);
        this.settings.disconnect(this._supportedPluginsChangedId);
        this.settings.run_dispose();

        GObject.signal_handlers_destroy(this);
    }
});

