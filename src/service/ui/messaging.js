'use strict';

const Tweener = imports.tweener.tweener;

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;

const Contacts = imports.service.ui.contacts;
const Sms = imports.service.plugins.sms;
const URI = imports.utils.uri;


/**
 * Return a human-readable timestamp.
 *
 * @param {Number} time - Milliseconds since the epoch (local time)
 * @return {String} - A timestamp similar to what Android Messages uses
 */
function getTime(time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let now = GLib.DateTime.new_now_local();
    let diff = now.difference(date);

    switch (true) {
        // Super recent
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        // Under an hour
        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Yesterday, but less than 24 hours ago
        case (diff < GLib.TIME_SPAN_DAY && (now.get_day_of_month() !== date.get_day_of_month())):
            // TRANSLATORS: Yesterday, but less than 24 hours (eg. Yesterday · 11:29 PM)
            return _('Yesterday・%s').format(date.format('%l:%M %p'));

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        // Less than a week ago
        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%A・%l:%M %p');

        default:
            return date.format('%b %e');
    }
}


function getShortTime(time) {
    let date = GLib.DateTime.new_from_unix_local(time / 1000);
    let diff = GLib.DateTime.new_now_local().difference(date);

    switch (true) {
        case (diff < GLib.TIME_SPAN_MINUTE):
            // TRANSLATORS: Less than a minute ago
            return _('Just now');

        case (diff < GLib.TIME_SPAN_HOUR):
            // TRANSLATORS: Time duration in minutes (eg. 15 minutes)
            return ngettext(
                '%d minute',
                '%d minutes',
                (diff / GLib.TIME_SPAN_MINUTE)
            ).format(diff / GLib.TIME_SPAN_MINUTE);

        // Less than a day ago
        case (diff < GLib.TIME_SPAN_DAY):
            return date.format('%l:%M %p');

        case (diff < (GLib.TIME_SPAN_DAY * 7)):
            return date.format('%a');

        default:
            return date.format('%b %e');
    }
}

function getContactsForAddresses(device, addresses) {
    let contacts = {};

    for (let i = 0, len = addresses.length; i < len; i++) {
        let address = addresses[i].address;

        contacts[address] = device.contacts.query({
            number: address
        });
    }
}


/**
 * A simple GtkLabel subclass with a chat bubble appearance
 */
var MessageLabel = GObject.registerClass({
    GTypeName: 'GSConnectMessageLabel'
}, class MessageLabel extends Gtk.Label {

    _init(message) {
        this.message = message;
        let incoming = (message.type === Sms.MessageBox.INBOX);

        super._init({
            label: URI.linkify(message.body, message.date),
            halign: incoming ? Gtk.Align.START : Gtk.Align.END,
            selectable: true,
            tooltip_text: getTime(message.date),
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0
        });

        if (incoming) {
            this.get_style_context().add_class('message-in');
        } else {
            this.get_style_context().add_class('message-out');
        }
    }

    vfunc_activate_link(uri) {
        Gtk.show_uri_on_window(
            this.get_toplevel(),
            uri.includes('://') ? uri : `http://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip) {
        if (super.vfunc_query_tooltip(x, y, keyboard_tooltip, tooltip)) {
            tooltip.set_text(getTime(this.message.date));
            return true;
        }

        return false;
    }
});


var MessageRow = GObject.registerClass({
    GTypeName: 'GSConnectMessageRow'
}, class MessageWidget extends Gtk.ListBoxRow {

    _init(message, contact) {
        super._init({
            activatable: false,
            selectable: false,
            hexpand: true,
            visible: true
        });

        // Sort properties
        this.message = message;
        this.date = message.date;
        this.type = message.type;
        this.sender = message.addresses[0].address || 'unknown';

        this._grid = new Gtk.Grid({
            can_focus: false,
            hexpand: true,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: this.incoming ? 18 : 6,
            column_spacing: 6,
            halign: this.incoming ? Gtk.Align.START : Gtk.Align.END,
            visible: true
        });
        this.add(this._grid);

        this._box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            visible: true
        });
        this._grid.attach(this._box, 1, 0, 1, 1);

        this._label = new Gtk.Label({
            label: URI.linkify(message.body, message.date),
            halign: this.incoming ? Gtk.Align.START : Gtk.Align.END,
            selectable: true,
            tooltip_text: getTime(message.date),
            use_markup: true,
            visible: true,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0
        });
        this._label.connect('activate-link', this._onActivateLink);
        this._box.add(this._label);

        this._image = new Gtk.Image({
            icon_name: 'image-loading-symbolic',
            halign: Gtk.Align.CENTER,
            pixel_size: 32,
            height_request: 90,
            width_request: 120,
            visible: false,
        });
        this._image.get_style_context().add_class(Gtk.STYLE_CLASS_BACKGROUND);
        this._box.add(this._image);

        if (this.incoming) {
            this._box.get_style_context().add_class('message-in');

            // Add avatar for incoming messages
            this._avatar = new Contacts.Avatar(contact);
            this._avatar.valign = Gtk.Align.END;
            this._grid.attach(this._avatar, 0, 0, 1, 1);
        } else {
            this._box.get_style_context().add_class('message-out');
        }
    }

    _onActivateLink(label, uri) {
        Gtk.show_uri_on_window(
            label.get_toplevel(),
            uri.includes('://') ? uri : `https://${uri}`,
            Gtk.get_current_event_time()
        );

        return true;
    }

    get incoming() {
        if (this._incoming === undefined)
            this._incoming = (this.message.type === Sms.MessageBox.INBOX);

        return this._incoming;
    }

    get show_avatar() {
        if (this._avatar === undefined)
            return false;

        return this._avatar.visible;
    }

    set show_avatar(visible) {
        if (this.show_avatar === visible)
            return;

        // Adjust the margins
        if (visible) {
            this._grid.margin_start = this.incoming ? 6 : 56;
            this._grid.margin_bottom = 6;
        } else {
            this._grid.margin_start = this.incoming ? 44 : 56;
            this._grid.margin_bottom = 0;
        }

        // Show hide the avatar
        if (this.incoming) {
            this._avatar.visible = visible;
        }
    }

    preview() {
        let uris = URI.findUrls(this.message.body);

        if (uris.length > 0) {
            this._image.visible = true;

            URI.Thumbnailer.getDefault().getThumbnail(uris[0].url, (path) => {
                this._image.set_from_file(path);

                if (this._image.pixbuf) {
                    let title = this._image.pixbuf.get_option('tEXt::Title');
                    this._image.tooltip_text = title;
                }
            });
        }
    }
});


/**
 * A ListBoxRow for a preview of a conversation
 */
const ThreadRow = GObject.registerClass({
    GTypeName: 'GSConnectThreadRow'
}, class ThreadRow extends Gtk.ListBoxRow {
    _init(contacts, message) {
        super._init({visible: true});

        // Row layout
        let grid = new Gtk.Grid({
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 8,
            margin_end: 8,
            column_spacing: 8,
            visible: true
        });
        this.add(grid);

        // Contact Avatar
        this._avatar = new Contacts.Avatar(null);
        grid.attach(this._avatar, 0, 0, 1, 3);

        // Contact Name
        this._name = new Gtk.Label({
            halign: Gtk.Align.START,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._name, 1, 0, 1, 1);

        // Message Time
        this._time = new Gtk.Label({
            halign: Gtk.Align.END,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        this._time.get_style_context().add_class('dim-label');
        grid.attach(this._time, 2, 0, 1, 1);

        // Message Body
        this._body = new Gtk.Label({
            halign: Gtk.Align.START,
            ellipsize: Pango.EllipsizeMode.END,
            use_markup: true,
            xalign: 0,
            visible: true
        });
        grid.attach(this._body, 1, 1, 2, 1);

        this.contacts = contacts;
        this.message = message;
    }

    get date() {
        return this._message.date;
    }

    get thread_id() {
        return this._message.thread_id;
    }

    get message() {
        return this._message;
    }

    set message(message) {
        this._message = message;
        this._sender = message.addresses[0].address || 'unknown';

        // Contact Name
        let nameLabel = _('Unknown Contact');

        // Update avatar for single-recipient messages
        if (message.addresses.length === 1) {
            this._avatar.contact = this.contacts[this._sender];
            nameLabel = GLib.markup_escape_text(this._avatar.contact.name, -1);
        } else {
            this._avatar.contact = null;
            nameLabel = _('Group Message');
        }

        // Contact Name & Message body
        let bodyLabel = message.body.split(/\r|\n/)[0];
        bodyLabel = GLib.markup_escape_text(bodyLabel, -1);

        // Ignore the 'read' flag if it's an outgoing message
        if (message.type === Sms.MessageBox.SENT) {
            // TRANSLATORS: An outgoing message body in a conversation summary
            bodyLabel = _('You: %s').format(bodyLabel);

        // Otherwise make it bold if it's unread
        } else if (message.read === Sms.MessageStatus.UNREAD) {
            nameLabel = '<b>' + nameLabel + '</b>';
            bodyLabel = '<b>' + bodyLabel + '</b>';
        }

        // Set the labels, body always smaller
        this._name.label = nameLabel;
        this._body.label = '<small>' + bodyLabel + '</small>';

        // Time
        let timeLabel = '<small>' + getShortTime(message.date) + '</small>';
        this._time.label = timeLabel;
    }

    update() {
        let timeLabel = '<small>' + getShortTime(this.message.date) + '</small>';
        this._time.label = timeLabel;
    }
});


const ConversationWidget = GObject.registerClass({
    GTypeName: 'GSConnectConversationWidget',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing this conversation',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'has-pending': GObject.ParamSpec.boolean(
            'has-pending',
            'Has Pending',
            'Whether there are sent messages pending confirmation',
            GObject.ParamFlags.READABLE,
            false
        ),
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/conversation.ui',
    Children: [
        'entry', 'list', 'scrolled',
        'pending', 'pending-box'
    ]
}, class ConversationWidget extends Gtk.Grid {

    _init(params) {
        super._init({
            device: params.device,
            plugin: params.plugin
        });
        Object.assign(this, params);

        this.device.bind_property(
            'connected',
            this.entry,
            'sensitive',
            GObject.BindingFlags.SYNC_CREATE
        );

        // If we're disconnected pending messages might not succeed, but we'll
        // leave them until reconnect when we'll ask for an update
        this._connectedId = this.device.connect(
            'notify::connected',
            this._onConnected.bind(this)
        );

        // Pending messages
        this.pending.date = Number.MAX_SAFE_INTEGER;
        this.bind_property(
            'has-pending',
            this.pending,
            'visible',
            GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE
        );

        // Auto-scrolling
        this._vadj = this.scrolled.get_vadjustment();
        this._scrolledId = this._vadj.connect(
            'value-changed',
            this._holdPosition.bind(this)
        );

        // Message List
        this.list.set_header_func(this._headerMessages);
        this.list.set_sort_func(this._sortMessages);
        this._populateMessages();

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);
    }

    get addresses() {
        if (this._addresses === undefined) {
            this._addresses = [];
        }

        return this._addresses;
    }

    set addresses(addresses) {
        if (!addresses || addresses.length === 0) {
            this._addresses = [];
            this._contacts = {};
            return;
        }

        this._addresses = addresses;

        // Lookup a contact for each address object
        for (let i = 0, len = this.addresses.length; i < len; i++) {
            let address = this.addresses[i].address;

            this.contacts[address] = this.device.contacts.query({
                number: address
            });
        }

        // TODO: Mark the entry as insensitive for group messages
        if (this.addresses.length > 1) {
            this.entry.placeholder_text = _('Not available');
            this.entry.secondary_icon_name = null;
            this.entry.secondary_icon_tooltip_text = null;
            this.entry.sensitive = false;
            this.entry.tooltip_text = null;
        }
    }

    get contacts() {
        if (this._contacts === undefined) {
            this._contacts = {};
        }

        return this._contacts;
    }

    get has_pending() {
        return (this.pending_box.get_children().length);
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        if (this._thread_id === undefined) {
            this._thread_id = null;
        }

        return this._thread_id;
    }

    set thread_id(thread_id) {
        let thread = this.plugin.threads[thread_id];
        let message = (thread) ? thread[0] : null;

        if (message && this.addresses.length === 0) {
            this.addresses = message.addresses;
            this._thread_id = thread_id;
        }
    }

    _onConnected(device) {
        if (device.connected) {
            this.pending_box.foreach(msg => msg.destroy());
        }
    }

    _onDestroy(conversation) {
        conversation.device.disconnect(conversation._connectedId);
        conversation._vadj.disconnect(conversation._scrolledId);

        conversation.list.foreach(message => {
            // HACK: temporary mitigator for mysterious GtkListBox leak
            message.run_dispose();
            imports.system.gc();
        });
    }

    _onEdgeReached(scrolled_window, pos) {
        // Try to load more messages
        if (pos === Gtk.PositionType.TOP) {
            this.logPrevious();

        // Release any hold to resume auto-scrolling
        } else if (pos === Gtk.PositionType.BOTTOM) {
            this._releasePosition();
        }
    }

    _onEntryChanged(entry) {
        entry.secondary_icon_sensitive = (entry.text.length);
    }

    _onKeyPressEvent(entry, event) {
        let keyval = event.get_keyval()[1];
        let state = event.get_state()[1];
        let mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Return && (mask & Gdk.ModifierType.SHIFT_MASK)) {
            entry.emit('insert-at-cursor', '\n');
            return true;
        }

        return false;
    }

    _onSendMessage(entry, signal_id, event) {
        // Don't send empty texts
        if (!this.entry.text.trim()) return;

        // Send the message
        this.plugin.sendMessage(this.addresses, entry.text);

        // Log the message as pending
        let message = new MessageLabel({
            body: this.entry.text,
            date: Date.now(),
            type: Sms.MessageBox.SENT
        });
        this.pending_box.add(message);
        this.notify('has-pending');

        // Clear the entry
        this.entry.text = '';
    }

    _onSizeAllocate(listbox, allocation) {
        let upper = this._vadj.get_upper();
        let pageSize = this._vadj.get_page_size();

        // If the scrolled window hasn't been filled yet, load another message
        if (upper <= pageSize) {
            this.logPrevious();
            this.scrolled.get_child().check_resize();

        // We've been asked to hold the position, so we'll reset the adjustment
        // value and update the hold position
        } else if (this.__pos) {
            this._vadj.set_value(upper - this.__pos);

        // Otherwise we probably appended a message and should scroll to it
        } else {
            this._scrollPosition(Gtk.PositionType.BOTTOM);
        }
    }

    /**
     * Messages
     */
    _createMessageRow(message) {
        let sender = message.addresses[0].address || 'unknown';

        // Ensure we have a contact
        if (this.contacts[sender] === undefined) {
            this.contacts[sender] = this.device.contacts.query({
                number: sender
            });
        }

        let row = new MessageRow(message, this.contacts[sender]);

        if (row.incoming && this.plugin.settings.get_boolean('url-previews'))
            row.preview();

        return row;
    }

    _populateMessages() {
        this.__first = null;
        this.__last = null;
        this.__pos = 0;
        this.__messages = [];

        // Try and find a thread_id for this number
        if (this.thread_id === null && this.addresses.length) {
            this._thread_id = this.plugin.getThreadIdForAddresses(this.addresses);
        }

        // Make a copy of the thread and fill the window with messages
        if (this.plugin.threads[this.thread_id]) {
            this.__messages = this.plugin.threads[this.thread_id].slice(0);
            this.logPrevious();
        }
    }

    _headerMessages(row, before) {
        // Skip pending
        if (row.get_name() === 'pending') return;

        if (before === null) {
            row.show_avatar = true;
            return;
        }

        // Add date header if the last message was more than an hour ago
        let header = row.get_header();

        if ((row.date - before.date) > GLib.TIME_SPAN_HOUR / 1000) {
            if (!header) {
                header = new Gtk.Label({visible: true});
                header.get_style_context().add_class('dim-label');
                row.set_header(header);
            }

            header.label = getTime(row.date);

            // Also show the avatar
            row.show_avatar = true;

        // Or if the previous sender was the same, hide its avatar
        } else if (row.type === before.type &&
                   row.sender.equalsPhoneNumber(before.sender)) {
            before.show_avatar = false;
            row.show_avatar = true;

        // otherwise show the avatar
        } else {
            row.show_avatar = true;
        }
    }

    _holdPosition() {
        this.__pos = this._vadj.get_upper() - this._vadj.get_value();
    }

    _releasePosition() {
        this.__pos = 0;
    }

    _scrollPosition(pos = Gtk.PositionType.BOTTOM, animate = true) {
        let vpos = pos;
        this._vadj.freeze_notify();

        if (pos === Gtk.PositionType.BOTTOM) {
            vpos = this._vadj.get_upper() - this._vadj.get_page_size();
        }


        if (animate) {
            Tweener.addTween(this._vadj, {
                value: vpos,
                time: 0.5,
                transition: 'easeInOutCubic',
                onComplete: () => this._vadj.thaw_notify()
            });
        } else {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._vadj.set_value(vpos);
                this._vadj.thaw_notify();
            });
        }
    }

    _sortMessages(row1, row2) {
        return (row1.date > row2.date) ? 1 : -1;
    }

    /**
     * Log the next message in the conversation.
     *
     * @param {object} message - A message object
     */
    logNext(message) {
        try {
            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT)
                return;

            // Append the message
            let row = this._createMessageRow(message);
            this.list.add(row);
            this.list.invalidate_headers();

            // Remove the first pending message
            if (this.has_pending && message.type === Sms.MessageBox.SENT) {
                this.pending_box.get_children()[0].destroy();
                this.notify('has-pending');
            }
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Log the previous message in the thread
     */
    logPrevious() {
        try {
            let message = this.__messages.pop();

            if (!message) return;

            // TODO: Unsupported MessageBox
            if (message.type !== Sms.MessageBox.INBOX &&
                message.type !== Sms.MessageBox.SENT) {
                throw TypeError(`invalid message box "${message.type}"`);
            }

            // Prepend the message
            let row = this._createMessageRow(message);
            this.list.prepend(row);
            this.list.invalidate_headers();
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Set the contents of the message entry
     *
     * @param {string} text - The message to place in the entry
     */
    setMessage(text) {
        this.entry.text = text;
        this.entry.emit('move-cursor', 0, text.length, false);
    }
});


/**
 * A Gtk.ApplicationWindow for SMS conversations
 */
var Window = GObject.registerClass({
    GTypeName: 'GSConnectMessagingWindow',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'thread-id': GObject.ParamSpec.string(
            'thread-id',
            'Thread ID',
            'The current thread',
            GObject.ParamFlags.READWRITE,
            ''
        )
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/messaging-window.ui',
    Children: [
        'headerbar', 'infobar',
        'thread-list', 'stack'
    ]
}, class Window extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(params);
        this.headerbar.subtitle = this.device.name;

        this.insert_action_group('device', this.device);

        // Device Status
        this.device.bind_property(
            'connected',
            this.infobar,
            'reveal-child',
            GObject.BindingFlags.INVERT_BOOLEAN
        );

        // Contacts
        this.contact_chooser = new Contacts.ContactChooser({
            device: this.device
        });
        this.stack.add_named(this.contact_chooser, 'contact-chooser');

        this._numberSelectedId = this.contact_chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );

        // Threads
        this.thread_list.set_sort_func(this._sortThreads);

        this._threadsChangedId = this.plugin.connect(
            'notify::threads',
            this._onThreadsChanged.bind(this)
        );

        this._timestampThreadsId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            60,
            this._timestampThreads.bind(this)
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        this._sync();
        this._onThreadsChanged();
        this.restoreGeometry('messaging');
    }

    vfunc_delete_event(event) {
        this.saveGeometry();
        return this.hide_on_delete();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get thread_id() {
        return this.stack.visible_child_name;
    }

    set thread_id(thread_id) {
        thread_id = `${thread_id}`; // FIXME

        // Reset to the empty placeholder
        if (!thread_id) {
            this.thread_list.select_row(null);
            this.stack.set_visible_child_name('placeholder');
            return;
        }

        // Create a conversation widget if there isn't one
        let conversation = this.stack.get_child_by_name(thread_id);
        let thread = this.plugin.threads[thread_id];

        if (conversation === null) {
            if (!thread) {
                debug(`Thread ID ${thread_id} not found`);
                return;
            }

            conversation = new ConversationWidget({
                device: this.device,
                plugin: this.plugin,
                thread_id: thread_id
            });

            this.stack.add_named(conversation, thread_id);
        }

        // Figure out whether this is a multi-recipient thread
        this._setHeaderBar(thread[0].addresses);

        // Select the conversation and entry active
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.has_focus = true;

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread_id');
    }

    _setHeaderBar(addresses = []) {
        let address = addresses[0].address;
        let contact = this.device.contacts.query({number: address});

        if (addresses.length === 1) {
            this.headerbar.title = contact.name;
            this.headerbar.subtitle = Contacts.getDisplayNumber(contact, address);
        } else {
            let otherLength = addresses.length - 1;

            this.headerbar.title = contact.name;
            this.headerbar.subtitle = ngettext(
                'And %d other contact',
                'And %d others',
                otherLength
            ).format(otherLength);
        }
    }

    _sync() {
        this.device.contacts.fetch();
        this.plugin.connected();
    }

    _onDestroy(window) {
        GLib.source_remove(window._timestampThreadsId);
        window.contact_chooser.disconnect(window._numberSelectedId);
        window.plugin.disconnect(window._threadsChangedId);
    }

    _onNewConversation() {
        this._sync();
        this.stack.set_visible_child_name('contact-chooser');
        this.thread_list.select_row(null);
        this.contact_chooser.entry.has_focus = true;
    }

    _onNumberSelected(chooser, number) {
        let contacts = chooser.getSelected();
        let row = this._getRowForContacts(contacts);

        if (row) {
            this.thread_list.select_row(row);
        } else {
            this.setContacts(contacts);
        }
    }

    /**
     * Threads
     */
    _onThreadsChanged() {
        // Get the last message in each thread
        let messages = {};

        for (let [thread_id, thread] of Object.entries(this.plugin.threads)) {
            let message = thread[thread.length - 1];

            // Skip messages without a body (eg. MMS messages without text)
            if (message.body) {
                messages[thread_id] = thread[thread.length - 1];
            }
        }

        // Update existing summaries and destroy old ones
        for (let row of this.thread_list.get_children()) {
            let message = messages[row.thread_id];

            // If it's an existing conversation, update it
            if (message) {
                // Ensure there's a contact mapping
                let sender = message.addresses[0].address || 'unknown';

                if (row.contacts[sender] === undefined) {
                    row.contacts[sender] = this.device.contacts.query({
                        number: sender
                    });
                }

                row.message = message;
                delete messages[row.thread_id];

            // Otherwise destroy it
            } else {
                // Destroy the conversation widget
                let conversation = this.stack.get_child_by_name(`${row.thread_id}`);

                if (conversation) {
                    conversation.destroy();
                    imports.system.gc();
                }

                // Then the summary widget
                row.destroy();
                // HACK: temporary mitigator for mysterious GtkListBox leak
                imports.system.gc();
            }
        }

        // What's left in the dictionary is new summaries
        for (let message of Object.values(messages)) {
            let contacts = this.device.contacts.lookupAddresses(message.addresses);
            let conversation = new ThreadRow(contacts, message);
            this.thread_list.add(conversation);
        }

        // Re-sort the summaries
        this.thread_list.invalidate_sort();
    }

    // GtkListBox::row-selected
    _onThreadSelected(box, row) {
        // Show the conversation for this number (if applicable)
        if (row) {
            this.thread_id = row.thread_id;

        // Show the placeholder
        } else {
            this.headerbar.title = _('Messaging');
            this.headerbar.subtitle = this.device.name;
        }
    }

    _sortThreads(row1, row2) {
        return (row1.date > row2.date) ? -1 : 1;
    }

    _timestampThreads() {
        if (this.visible) {
            this.thread_list.foreach(row => row.update());
        }

        return GLib.SOURCE_CONTINUE;
    }

    /**
     * Find the thread row for @contacts
     *
     * @param {Array of Object} contacts - A contact group
     * @return {ThreadRow|null} - The thread row or %null
     */
    _getRowForContacts(contacts) {
        let addresses = Object.keys(contacts).map(address => {
            return {address: address};
        });

        // Try to find a thread_id
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        for (let row of this.thread_list.get_children()) {
            if (row.message.thread_id === thread_id)
                return row;
        }

        return null;
    }

    setContacts(contacts) {
        // Group the addresses
        let addresses = [];

        for (let address of Object.keys(contacts)) {
            addresses.push({address: address});
        }

        // Try to find a thread ID for this address group
        let thread_id = this.plugin.getThreadIdForAddresses(addresses);

        if (thread_id === null) {
            thread_id = GLib.uuid_string_random();
        } else {
            thread_id = thread_id.toString();
        }

        // Try to find a thread row for the ID
        let row = this._getRowForContacts(contacts);

        if (row !== null) {
            this.thread_list.select_row(row);
            return;
        }

        // We're creating a new conversation
        let conversation = new ConversationWidget({
            device: this.device,
            plugin: this.plugin,
            addresses: addresses
        });

        // Set the headerbar
        this._setHeaderBar(addresses);

        // Select the conversation and entry active
        this.stack.add_named(conversation, thread_id);
        this.stack.visible_child = conversation;
        this.stack.visible_child.entry.has_focus = true;

        // There was a pending message waiting for a conversation to be chosen
        if (this._pendingShare) {
            conversation.setMessage(this._pendingShare);
            this._pendingShare = null;
        }

        this._thread_id = thread_id;
        this.notify('thread-id');
    }

    _includesAddress(addresses, addressObj) {
        let number = addressObj.address.toPhoneNumber();

        for (let haystackObj of addresses) {
            let tnumber = haystackObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Try and find an existing conversation widget for @message.
     *
     * @param {object} message - A message object
     * @return {ConversationWidget|null} - A conversation widget or %null
     */
    getConversationForMessage(message) {
        // This shouldn't happen
        if (message === null) return null;

        // First try to find a conversation by thread_id
        let thread_id = `${message.thread_id}`;
        let conversation = this.stack.get_child_by_name(thread_id);

        if (conversation !== null) {
            return conversation;
        }

        // Try and find one by matching addresses, which is necessary if we've
        // started a thread locally and haven't set the thread_id
        let addresses = message.addresses;

        for (let conversation of this.stack.get_children()) {
            if (conversation.addresses === undefined ||
                conversation.addresses.length !== addresses.length) {
                continue;
            }

            let caddrs = conversation.addresses;

            // If we find a match, set `thread-id` on the conversation and the
            // child property `name`.
            if (addresses.every(addr => this._includesAddress(caddrs, addr))) {
                conversation._thread_id = thread_id;
                this.stack.child_set_property(conversation, 'name', thread_id);

                return conversation;
            }
        }

        return null;
    }

    /**
     * Set the contents of the message entry. If @pending is %false set the
     * message of the currently selected conversation, otherwise mark the
     * message to be set for the next selected conversation.
     *
     * @param {string} text - The message to place in the entry
     * @param {boolean} pending - Wait for a conversation to be selected
     */
    setMessage(message, pending = false) {
        try {
            if (pending) {
                this._pendingShare = message;
            } else {
                this.stack.visible_child.setMessage(message);
            }
        } catch (e) {
            debug(e);
        }
    }
});


/**
 * A Gtk.ApplicationWindow for selecting from open conversations
 */
var ConversationChooser = GObject.registerClass({
    GTypeName: 'GSConnectConversationChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'message': GObject.ParamSpec.string(
            'message',
            'Message',
            'The message to share',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin providing messages',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        )
    }
}, class ConversationChooser extends Gtk.ApplicationWindow {

    _init(params) {
        super._init(Object.assign({
            title: _('Share Link'),
            default_width: 300,
            default_height: 200
        }, params));
        this.set_keep_above(true);

        // HeaderBar
        this.headerbar = new Gtk.HeaderBar({
            title: _('Share Link'),
            subtitle: this.message,
            show_close_button: true,
            tooltip_text: this.message
        });
        this.set_titlebar(this.headerbar);

        let newButton = new Gtk.Button({
            image: new Gtk.Image({icon_name: 'list-add-symbolic'}),
            tooltip_text: _('New Conversation'),
            always_show_image: true
        });
        newButton.connect('clicked', this._new.bind(this));
        this.headerbar.pack_start(newButton);

        // Threads
        let scrolledWindow = new Gtk.ScrolledWindow({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.add(scrolledWindow);

        this.thread_list = new Gtk.ListBox({
            activate_on_single_click: false
        });
        this.thread_list.set_sort_func(Window.prototype._sortThreads);
        this.thread_list.connect('row-activated', this._select.bind(this));
        scrolledWindow.add(this.thread_list);

        // Filter Setup
        Window.prototype._onThreadsChanged.call(this);
        this.show_all();
    }

    get plugin() {
        return this._plugin || null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _new(button) {
        let message = this.message;
        this.destroy();

        this.plugin.sms();
        this.plugin.window._onNewConversation();
        this.plugin.window._pendingShare = message;
    }

    _select(box, row) {
        this.plugin.sms();
        this.plugin.window.thread_id = row.message.thread_id.toString();
        this.plugin.window.setMessage(this.message);

        this.destroy();
    }
});

