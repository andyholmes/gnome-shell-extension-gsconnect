'use strict';

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Core = imports.service.protocol.core;


/**
 * Multiplex Constants
 */
const DEFAULT_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
const BUFFER_SIZE = 4096;
const HEADER_SIZE = 19;
const PROTOCOL_MIN = 1;
const PROTOCOL_MAX = 1;


const MessageType = {
    PROTOCOL: 0,
    OPEN: 1,
    CLOSE: 2,
    READ: 3,
    WRITE: 4
};


/**
 * Pack a header and message into a Uint8Array
 *
 * @param {MessageType} type - One of the MessageType enum types
 * @param {string} uuid - A well formed UUID
 * @param {TypedArray} [message] - The message to be sent
 * @return {Uint8Array} - A header and message packed into a Uint8Array
 */
function packMessage(type, uuid, message = null) {
    let len = (message) ? message.buffer.byteLength : 0;
    let buf = new ArrayBuffer(HEADER_SIZE + len);
    let hdr = new DataView(buf, 0, HEADER_SIZE);
    let msg = new Uint8Array(buf);

    // Set type and size
    hdr.setUint8(0, type);
    hdr.setUint16(1, len);

    // Pack the UUID
    uuid = uuid.match(/[^-]{2}/g);

    for (let i = 3, h = 0; i < HEADER_SIZE; i++) {
        let byte = parseInt(uuid[h++], 16);
        hdr.setUint8(i, byte);
    }

    // Pack the message
    if (message !== null) {
        msg.set(message, HEADER_SIZE);
    }

    return msg;
}


/**
 * Unpack a header from a Uint8Array
 *
 * @param {Uint8Array} - A 19-byte packed message header
 * @return {array} - An array of type, size and UUID
 */
function unpackHeader(bytes) {
    let view = new DataView(bytes.buffer);

    let type = view.getUint8(0);
    let size = view.getUint16(1);
    let uuid = '';

    for (let i = 3; i < HEADER_SIZE; i++) {
        let hex = view.getUint8(i).toString(16);
        uuid += (hex.length % 2) ? `0${hex}` : hex;
    }

    uuid = uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

    return [type, size, uuid];
}


/**
 * Phony IO Streams
 */
class InputStream {

    constructor(channel) {
        this._line = '';
        this._bytes = [];
        this._cancellable = channel.cancellable;
        this._callback = null;
    }

    _read_bytes_check() {
        if (this._reject && this._cancellable.is_cancelled()) {
            let reject = this._reject;
            this._resolve = null;
            this._reject = null;

            reject(new Error('Operation was cancelled'));

        } else if (this._resolve && this._bytes.length) {
            // Reset the callback
            let resolve = this._resolve;
            this._resolve = null;
            this._reject = null;

            // Invoke the callback
            resolve(this._bytes.shift());
        }
    }

    read_bytes(resolve, reject) {
        this._resolve = resolve;
        this._reject = reject;

        this._read_bytes_check();
    }

    push_bytes(bytes) {
        if (bytes instanceof Uint8Array) {
            bytes = ByteArray.toGBytes(bytes);
        }

        // Append the bytes to the queue
        this._bytes.push(bytes);

        // Check if we have a pending operation
        this._read_bytes_check();
    }

    /**
     * A mock version of `g_input_stream_read_line_async()`
     */
    _read_line_check() {
        if (this._callback && this._line) {
            let lines = this._line.split('\n');

            if (lines.length > 1) {
                // Get the packet line
                let line = lines.shift();
                this._line = lines.join('\n');

                // Reset the callback
                let callback = this._callback;
                this._callback = null;

                // Invoke the callback
                callback(this, line);
            }
        }
    }

    push_line(chunk) {
        // Ensure the chunk is a string
        if (typeof chunk !== 'string') {
            chunk = ByteArray.toString(chunk);
        }

        // Append the chunk to the buffer
        this._line += chunk;

        // Check if we have a packet ready
        this._read_line_check();
    }

    read_line_async(io_priority, cancellable, callback) {
        this._callback = callback;

        // Check if we have a packet waiting
        this._read_line_check();
    }

    read_line_finish_utf8(res) {
        // FIXME: probably won't be called
        if (this._cancellable.is_cancelled()) {
            throw new Error('Operation was cancelled');
        }

        return [res, res.length];
    }

    close() {
        debug(new Error(), 'InputStream.close()');

        this._bytes = null;
        this._line = null;
        this._cancellable = null;
        this._callback = null;
    }
}


var OutputStream = GObject.registerClass({
    GTypeName: 'GSConnectMultiplexOutputStream',
    Implements: [Gio.PollableOutputStream, Gio.Seekable]
}, class OutputStream extends Gio.DataOutputStream {

    _init(channel) {
        super._init({
            base_stream: channel.muxer.output_stream,
            close_base_stream: false
        });

        this._channel = channel;
    }

    get channel() {
        return this._channel;
    }

    get uuid() {
        return this._channel.uuid;
    }

    vfunc_can_poll() {
        return true;
    }

    vfunc_is_writable() {
        return (this.channel.write_free > 0 && !this.base_stream.has_pending());
    }

    vfunc_create_source(cancellable) {
        // TODO: better polling
        return Gio.pollable_source_new_full(
            this,
            GLib.timeout_source_new(10),
            cancellable
        );
    }

    vfunc_write_fn(buffer, cancellable) {
        let message, written;

        // Partial write
        if (buffer.length > this.channel.write_free) {
            if (this.channel.write_free === 0) {
                debug('write allowed === 0');
            }

            message = buffer.subarray(0, this.channel.write_free);
            message = packMessage(MessageType.WRITE, this.uuid, message);

        // Whole write
        } else {
            message = packMessage(MessageType.WRITE, this.uuid, buffer);
        }

        // Compute effective write length
        written = super.vfunc_write_fn(message, cancellable) - HEADER_SIZE;
        this.channel.write_free -= written;

        return written;
    }
});


var Channel = GObject.registerClass({
    GTypeName: 'GSConnectMuxChannel',
    Implements: [Core.Channel]
}, class MuxChannel extends GObject.Object {

    _init(params) {
        super._init();
        Object.assign(this, params);

        //
        this.read_free = 0;
        this.write_free = 0;
    }

    get address() {
        return 'bluetooth://FIXME';
    }

    get input_stream() {
        if (this._input_stream === undefined) {
            this._input_stream = new InputStream(this);
        }

        return this._input_stream;
    }

    set input_stream(stream) {
        this._input_stream = stream;
    }

    get output_stream() {
        if (this._output_stream === undefined) {
            this._output_stream = new OutputStream(this);
        }

        return this._output_stream;
    }

    set output_stream(stream) {
        this._output_stream = stream;
    }

    get type() {
        return 'bluetooth';
    }

    async _recvIdent(size) {
        debug('receiving identity');

        try {
            let message = await this.muxer.read_all(size);
            let data = ByteArray.toString(message);

            // TODO: shouldn't happen?
            if (!data.endsWith('\n')) {
                throw new Error('partial identity');
            }

            this.identity = new Core.Packet(data);

            return this.muxer._connection;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     * @return {Gio.SocketConnection} - The connection after success
     */
    _sendIdent(size) {
        debug('sending identity');

        return new Promise((resolve, reject) => {
            this.output_stream.write_all_async(
                ByteArray.fromString(`${this.service.identity}`),
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        resolve(stream.write_all_finish(res)[1]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Attach to @device as the default channel used for packet exchange.
     *
     * @param {Device.Device} device - The device to attach to
     */
    attach(device) {
        try {
            // Detach any existing channel
            if (device._channel && device._channel !== this) {
                device._channel.cancellable.disconnect(device._channel._id);
                device._channel.close();
            }

            // Attach the new channel and parse it's identity
            device._channel = this;
            this._id = this.cancellable.connect(device._setDisconnected.bind(device));
            device._handleIdentity(this.identity);

            // Start listening for packets
            this.receive(device);
            this.muxer.receive(device);

            // Emit connected:: if necessary
            if (!device.connected) {
                device._setConnected();
            }
        } catch (e) {
            debug(e);
            this.close();
        }
    }

    async handshake(connection) {
        let type, size, uuid;

        try {
            // Negotiate the multiplex protocol version
            [type, size, uuid] = await this.muxer.read_header();

            if (type !== MessageType.PROTOCOL) {
                throw new Error('Expected PROTOCOL message');
            }

            let vmin = this.muxer.input_stream.read_uint16(this.cancellable);
            let vmax = this.muxer.input_stream.read_uint16(this.cancellable);

            if (vmin < PROTOCOL_MIN && vmax > PROTOCOL_MAX) {
                throw new Error(`unsupported protocol ${vmin}-${vmax}`);
            } else {
                this.muxer._protocol = vmax;
            }

            await this.muxer.sendProtocol();

            // First we send a READ message and get the next header
            await this.muxer.sendRead(DEFAULT_UUID);
            [type, size, uuid] = await this.muxer.read_header();

            // We're the client, opening a connection to the server
            if (type === MessageType.WRITE) {
                await this.open(connection, [type, size, uuid]);

            // We're the server, accepting an incoming connection
            } else if (type === MessageType.READ) {
                await this.accept(connection, [type, size, uuid]);
            } else {
                debug(`unexpected message type '${type}'`);
            }

            debug('connection accepted');
        } catch (e) {
            debug(e);
            return Promise.reject(e);
        }
    }

    async accept(connection, [type, size, uuid]) {
        try {
            debug('accepting connection from client');

            // Get the allowed write size and write the identity
            await this.muxer._recvRead(uuid);
            await this._sendIdent();

            // Get the second header
            // TODO: assert is WRITE
            [type, size, uuid] = await this.muxer.read_header();

            // Receive the identity, then top up the READ amount
            await this._recvIdent(size);
            this.read_free -= size;
            await this.muxer.sendRead(DEFAULT_UUID);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async open(connection, [type, size, uuid]) {
        try {
            debug('opening connection to server');

            // Receive the identity, then top up the READ amount
            await this._recvIdent(size);
            this.read_free -= size;
            await this.muxer.sendRead(DEFAULT_UUID);

            // Get the second header
            // TODO: assert is READ
            [type, size, uuid] = await this.muxer.read_header();

            // Get the allowed write size and write the identity
            await this.muxer._recvRead(uuid);
            await this._sendIdent();
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async close() {
        try {
            // TODO: this is the worst kind of reach-around
            if (this.uuid === DEFAULT_UUID) {
                this.muxer.close();
            }

            this.cancellable.cancel();
            this.input_stream.close(null);
            this.output_stream.close(null);
            await this.muxer.sendClose(this.uuid);
        } catch (e) {
            debug(e, this.uuid);
        } finally {
            this.muxer._channels.delete(this.uuid);
        }
    }
});


/**
 * File Transfers
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectMuxTransfer',
    Implements: [Core.Channel]
}, class Transfer extends Channel {

    /**
     * Override to untrack the transfer UUID
     */
    async close() {
        try {
            this.device._transfers.delete(this.uuid);
            await super.close();
        } catch (e) {
            debug(e);
        }
    }

    /**
     * Start a download. Requires the following properties to be defined:
     *
     * - `device`
     * - `muxer`
     * - `output_stream`
     * - `size`
     * - `uuid`
     */
    async download() {
        let result = false;
        let transferred = 0;

        try {
            // Track the transfer so it can be closed from the notification
            this.device._transfers.set(this.uuid, this);

            // Send the initial request for bytes
            this.muxer.sendRead(this.uuid);

            // Start the transfer
            while (transferred < this.size) {
                // Actually the BUFFER_SIZE here is irrelevant; we'll get what
                // we get and the input stream is an API compatible phony
                let bytes = await new Promise(this.input_stream.read_bytes.bind(this.input_stream));

                // We use `g_output_stream_write_bytes()` to ensure a reference
                // is held on @bytes, since the output stream is probably for a
                // GFile: https://gitlab.gnome.org/GNOME/gjs/issues/192
                transferred += await new Promise((resolve, reject) => {
                    this.output_stream.write_bytes_async(
                        bytes,
                        GLib.PRIORITY_DEFAULT,
                        this.cancellable,
                        (stream, res) => {
                            try {
                                resolve(stream.write_bytes_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });
            }

            result = (transferred === this.size);
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            await this.close();
        }

        return result;
    }

    /**
     * Start an upload. Requires the following properties to be defined:
     *
     * - `device`
     * - `muxer`
     * - `input_stream`
     * - `size`
     * - `uuid`
     */
    async upload(packet) {
        let result = false;
        let transferred = 0;

        try {
            // Track the transfer so it can be closed from the notification
            this.device._transfers.set(this.uuid, this);

            // Ask the device to open a multiplex channel
            await this.muxer.sendOpen(this.uuid);

            // Notify the device we're ready
            packet.body.payloadHash = this.checksum;
            packet.payloadSize = this.size;
            packet.payloadTransferInfo = {uuid: this.uuid};
            this.device.sendPacket(packet);

            // Start the transfer
            while (transferred < this.size) {
                // Even though internally kdeconnect-android will use a buffer
                // of 1024 bytes, the multiplex buffer will still be 4096 bytes
                let bytes = await new Promise((resolve, reject) => {
                    this.input_stream.read_bytes_async(
                        BUFFER_SIZE,
                        GLib.PRIORITY_DEFAULT,
                        this.cancellable,
                        (stream, res) => {
                            try {
                                resolve(stream.read_bytes_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                // We use `g_output_stream_write_all()` because the packed
                // multiplex message must be completely sent before continuing
                transferred += await new Promise((resolve, reject) => {
                    this.output_stream.write_all_async(
                        ByteArray.fromGBytes(bytes),
                        GLib.PRIORITY_DEFAULT,
                        this.cancellable,
                        (stream, res) => {
                            try {
                                resolve(stream.write_all_finish(res)[1]);
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });
            }

            result = (transferred === this.size);
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            await this.close();
        }

        return result;
    }
});



/**
 * A multiplex capable subclass of Core.Channel
 */
var Connection = class Connection {

    constructor(connection) {
        // Setup streams for multiplex messages (forced big endian)
        this._connection = connection;

        this.input_stream = new Gio.DataInputStream({
            base_stream: this._connection.input_stream,
            byte_order: Gio.DataStreamByteOrder.BIG_ENDIAN
        });

        this.output_stream = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream,
            byte_order: Gio.DataStreamByteOrder.BIG_ENDIAN
        });

        // Thread lock
        this.cancellable = new Gio.Cancellable();

        // Map of uuid -> Channel
        this._channels = new Map();

        // Prepare default channel
        this._default = new Channel({
            muxer: this,
            uuid: DEFAULT_UUID
        });

        this._channels.set(DEFAULT_UUID, this._default);
    }

    get protocol() {
        if (this._protocol === undefined) {
            return 1;
        }

        return this._protocol;
    }

    get service() {
        return Gio.Application.get_default();
    }

    /**
     * Close a channel. If @uuid is DEFAULT_UUID, the multiplex connection and
     * all channels will be closed.
     *
     * @param {uuid} - The channel UUID
     */
    async close() {
        try {
            if (this._closing) return;
            this._closing = true;

            // Close each Channel first
            for (let channel of this._channels.values()) {
                await channel.close();
            }

            // Trigger cancellable
            this.cancellable.cancel();

            // Close the socket and connection
            this._connection.socket.close();
            this._connection.close(null);
        } catch (e) {
            debug(e);
        }
    }

    _read(size) {
        return new Promise((resolve, reject) => {
            this.input_stream.read_bytes_async(
                size,
                GLib.PRIORITY_DEFAULT,
                this.cancellable,
                (stream, res) => {
                    try {
                        let bytes = stream.read_bytes_finish(res);
                        resolve(ByteArray.fromGBytes(bytes));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * A simple function for reading bytes from the input stream and returning
     * a Uint8Array. Attempts to read @size, stopping only on error.
     *
     * @param {number} size - Size in bytes to read
     * @return {Uint8Array} - A byte array of data
     */
    async read_all(size) {
        try {
            // Read the first chunk
            let byteArray = await this._read(size);

            // Keep reading until we've received the entire message
            while (size - byteArray.length) {
                let chunk = await this._read(size - byteArray.length);
                byteArray = Uint8Array.of(...byteArray, ...chunk);
            }

            return byteArray;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // FIXME: this is flaky
    async _recvProtocol() {
        try {
            let vmin = this.input_stream.read_uint16(this.cancellable);
            let vmax = this.input_stream.read_uint16(this.cancellable);

            if (vmin < PROTOCOL_MIN && vmax > PROTOCOL_MAX) {
                throw new Error(`Unsupported protocol ${vmin}-${vmax}`);
            } else if (this._protocol !== undefined) {
                throw new Error(`Protocol already set (v${this._protocol})`);
            } else {
                this._protocol = vmax;
            }
        } catch (e) {
            return Promise.reject(e);
        }
    }

    _recvOpen(uuid) {
        let channel = this._channels.get(uuid);

        if (!channel) {
            channel = new Transfer({
                muxer: this,
                uuid: uuid
            });
            this._channels.set(uuid, channel);

        } else {
            channel.read_free = 0;
            channel.write_free = 0;
            debug('channel already open', uuid);
        }
    }

    _recvClose(uuid) {
        let channel = this._channels.get(uuid);

        if (channel) {
            channel.close();
        } else {
            debug('channel already closed', uuid);
        }
    }

    _recvRead(uuid) {
        // Always read the amount uint16, or we'll get confused
        let amount = this.input_stream.read_uint16(this.cancellable);
        let channel = this._channels.get(uuid);

        // Ensure the channel exists
        if (channel) {
            channel.write_free += amount;
        } else {
            debug('no such channel', uuid);
            this.sendClose(uuid);
        }
    }

    /**
     * Read and unpack the next header from the connection
     *
     * @return {array[]} header - Array of type,size,uuid
     */
    async read_header() {
        try {
            let header = await this.read_all(HEADER_SIZE);
            return unpackHeader(header);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async read_message(uuid, size) {
        try {
            // Always read @size or we'll get confused
            let message = await this.read_all(size);
            let channel = this._channels.get(uuid);

            // Distribute the chunk to it's channel
            if (channel) {
                // Check if we've requested these bytes
                if (size > channel.read_free) {
                    debug(`Overwrite of ${size - channel.read_free}`, uuid);
                }

                // Bytes for the main packet channel
                if (uuid === DEFAULT_UUID) {
                    channel.input_stream.push_line(message);

                // Bytes for a payload transfer
                } else {
                    channel.input_stream.push_bytes(message);
                }

                channel.read_free -= size;
                this.sendRead(uuid);

            // This channel doesn't exist; inform the device
            } else {
                debug('no such channel; discarding data', uuid);
                this.sendClose(uuid);
            }
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async receive(device) {
        try {
            while (!this.cancellable.is_cancelled()) {
                // Read the next header
                let [type, size, uuid] = await this.read_header();

                switch (type) {
                    case MessageType.PROTOCOL:
                        await this._recvProtocol();
                        break;

                    case MessageType.OPEN:
                        this._recvOpen(uuid);
                        break;

                    case MessageType.CLOSE:
                        this._recvClose(uuid);
                        break;

                    case MessageType.READ:
                        this._recvRead(uuid);
                        break;

                    case MessageType.WRITE:
                        await this.read_message(uuid, size);
                        break;

                    default:
                        debug(`Unknown message type: ${type}`);
                }

                // FIXME :(
                imports.system.gc();
            }
        } catch (e) {
            debug(e.message, device.name);
            this.close();
        }
    }

    /**
     * Send a packed multiplex control message
     *
     * @param {TypedArray} message - A packed control message
     */
    async sendMessage(message) {
        try {
            // TODO: better polling
            while (this.output_stream.has_pending()) {
                debug('requeueing control message');
                await Promise.timeout(GLib.PRIORITY_HIGH, 10);
            }

            // TODO: confirm partial writes never happen
            await new Promise((resolve, reject) => {
                this.output_stream.write_bytes_async(
                    ByteArray.toGBytes(message),
                    GLib.PRIORITY_DEFAULT,
                    this.cancellable,
                    (stream, res) => {
                        try {
                            resolve(stream.write_bytes_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            debug(e.message);
            this.close();
        }
    }

    /**
     * Request to close an open channel
     *
     * @param {string} uuid - The channel UUID
     */
    sendClose(uuid) {
        let message = packMessage(MessageType.CLOSE, uuid);
        return this.sendMessage(message);
    }

    /**
     * Request a new channel
     *
     * @param {string} uuid - The UUID for the new channel
     */
    sendOpen(uuid) {
        let message = packMessage(MessageType.OPEN, uuid);
        return this.sendMessage(message);
    }

    /**
     * Send our min/max supported protocol versions
     */
    sendProtocol() {
        let buf = new ArrayBuffer(4);
        let bytes = new Uint8Array(buf);
        let view = new DataView(buf);
        view.setUint16(0, PROTOCOL_MIN);
        view.setUint16(2, PROTOCOL_MAX);

        let message = packMessage(MessageType.PROTOCOL, DEFAULT_UUID, bytes);
        return this.sendMessage(message);
    }

    /**
     * Request more bytes for the channel @uuid
     *
     * @param {string} uuid - The channel UUID
     */
    async sendRead(uuid) {
        try {
            let channel = this._channels.get(uuid);

            if (channel) {
                // All read requests are "top-ups"
                let size = BUFFER_SIZE - channel.read_free;

                // Pack message
                let buf = new ArrayBuffer(2);
                let bytes = new Uint8Array(buf);
                let view = new DataView(buf);
                view.setUint16(0, size);
                let message = packMessage(MessageType.READ, uuid, bytes);

                // Send message and update read_free
                await this.sendMessage(message);
                channel.read_free += size;
            } else {
                debug('No such channel', uuid);
            }
        } catch (e) {
            logError(e);
        }
    }
};

