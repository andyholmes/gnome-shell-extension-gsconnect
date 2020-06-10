'use strict';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const thumb = imports.service.ui.thumbnailer;


/**
 * The same regular expression used in GNOME Shell
 *
 * http://daringfireball.net/2010/07/improved_regex_for_matching_urls
 */
const _balancedParens = '\\((?:[^\\s()<>]+|(?:\\(?:[^\\s()<>]+\\)))*\\)';
const _leadingJunk = '[\\s`(\\[{\'\\"<\u00AB\u201C\u2018]';
const _notTrailingJunk = '[^\\s`!()\\[\\]{};:\'\\".,<>?\u00AB\u00BB\u201C\u201D\u2018\u2019]';

const _urlRegexp = new RegExp(
    '(^|' + _leadingJunk + ')' +
    '(' +
        '(?:' +
            '(?:http|https)://' +                 // scheme://
            '|' +
            'www\\d{0,3}[.]' +                    // www.
            '|' +
            '[a-z0-9.\\-]+[.][a-z]{2,4}/' +       // foo.xx/
        ')' +
        '(?:' +                                   // one or more:
            '[^\\s()<>]+' +                       // run of non-space non-()
            '|' +                                 // or
            _balancedParens +                     // balanced parens
        ')+' +
        '(?:' +                                   // end with:
            _balancedParens +                     // balanced parens
            '|' +                                 // or
            _notTrailingJunk +                    // last non-junk char
        ')' +
    ')', 'gi');


/**
 * sms/tel URI RegExp (https://tools.ietf.org/html/rfc5724)
 *
 * A fairly lenient regexp for sms: URIs that allows tel: numbers with chars
 * from global-number, local-number (without phone-context) and single spaces.
 * This allows passing numbers directly from libfolks or GData without
 * pre-processing. It also makes an allowance for URIs passed from Gio.File
 * that always come in the form "sms:///".
 */
let _smsParam = "[\\w.!~*'()-]+=(?:[\\w.!~*'()-]|%[0-9A-F]{2})*";
let _telParam = ";[a-zA-Z0-9-]+=(?:[\\w\\[\\]/:&+$.!~*'()-]|%[0-9A-F]{2})+";
let _lenientDigits = '[+]?(?:[0-9A-F*#().-]| (?! )|%20(?!%20))+';
let _lenientNumber = _lenientDigits + '(?:' + _telParam + ')*';

var _smsRegex = new RegExp(
    '^' +
    'sms:' +                                // scheme
    '(?:[/]{2,3})?' +                       // Gio.File returns ":///"
    '(' +                                   // one or more...
        _lenientNumber +                    // phone numbers
        '(?:,' + _lenientNumber + ')*' +    // separated by commas
    ')' +
    '(?:\\?(' +                             // followed by optional...
        _smsParam +                         // parameters...
        '(?:&' + _smsParam + ')*' +         // separated by "&" (unescaped)
    '))?' +
    '$', 'g');                              // fragments (#foo) not allowed


var _numberRegex = new RegExp(
    '^' +
    '(' + _lenientDigits + ')' +            // phone number digits
    '((?:' + _telParam + ')*)' +            // followed by optional parameters
    '$', 'g');


/**
 * Searches @str for URLs and returns an array of objects with %url
 * properties showing the matched URL string, and %pos properties indicating
 * the position within @str where the URL was found.
 *
 * @param {string} str - the string to search
 * @returns {object[]} - the list of match objects, as described above
 */
function findUrls(str) {
    _urlRegexp.lastIndex = 0;

    let res = [], match;

    while ((match = _urlRegexp.exec(str))) {
        let name = match[2];
        let url = GLib.uri_parse_scheme(name) ? name : `http://${name}`;
        res.push({name, url, pos: match.index + match[1].length});
    }

    return res;
}


/**
 * Return a string with URLs couched in <a> tags, parseable by Pango and
 * using the same RegExp as GNOME Shell.
 *
 * @param {string} str - The string to be modified
 * @param {string} [title] - An optional title (eg. alt text, tooltip)
 * @return {string} - the modified text
 */
function linkify(str, title = null) {
    let text = GLib.markup_escape_text(str, -1);

    _urlRegexp.lastIndex = 0;

    if (title) {
        return text.replace(
            _urlRegexp,
            `$1<a href="$2" title="${title}">$2</a>`
        );
    } else {
        return text.replace(_urlRegexp, '$1<a href="$2">$2</a>');
    }
}


/**
 * A simple parsing class for sms: URI's (https://tools.ietf.org/html/rfc5724)
 */
var SmsURI = class URI {
    constructor(uri) {
        _smsRegex.lastIndex = 0;
        let [, recipients, query] = _smsRegex.exec(uri);

        this.recipients = recipients.split(',').map(recipient => {
            _numberRegex.lastIndex = 0;
            let [, number, params] = _numberRegex.exec(recipient);

            if (params) {
                for (let param of params.substr(1).split(';')) {
                    let [key, value] = param.split('=');

                    // add phone-context to beginning of
                    if (key === 'phone-context' && value.startsWith('+')) {
                        return value + unescape(number);
                    }
                }
            }

            return unescape(number);
        });

        if (query) {
            for (let field of query.split('&')) {
                let [key, value] = field.split('=');

                if (key === 'body') {
                    if (this.body) {
                        throw URIError('duplicate "body" field');
                    }

                    this.body = (value) ? decodeURIComponent(value) : undefined;
                }
            }
        }
    }

    toString() {
        let uri = 'sms:' + this.recipients.join(',');

        return (this.body) ? uri + '?body=' + escape(this.body) : uri;
    }
};


/**
 * Thumbnailer class from Polari
 *
 * Credits: https://gitlab.gnome.org/GNOME/polari/-/merge_requests/134
 */
var Thumbnailer = class Thumbnailer {
    static getDefault() {
        if (!this._singleton)
            this._singleton = new Thumbnailer();
        return this._singleton;
    }

    constructor() {
        this._urlQueue = [];
        this._subProc = null;
        this._thumbnailsDir = `${GLib.get_user_cache_dir()}/gsconnect/thumbnails/`;

        GLib.mkdir_with_parents(this._thumbnailsDir, 0o755);
    }

    getThumbnail(uri, callback) {
        let filename = this._generateFilename(uri);
        let data = {uri, filename, callback};

        this._processData(data);
    }

    _processData(data) {
        if (GLib.file_test(`${data.filename}`, GLib.FileTest.EXISTS))
            this._generationDone(data);
        else if (!this._subProc)
            this._generateThumbnail(data);
        else
            this._urlQueue.push(data);
    }

    _generationDone(data) {
        data.callback(data.filename);

        let nextData = this._urlQueue.shift();
        if (nextData)
            this._processData(nextData);
    }

    async _generateThumbnail(data) {
        try {
            let {filename, uri} = data;
            let task = new thumb.Task(uri, filename);
            await task.run();
        } catch (e) {
            debug(e, data.uri);
        } finally {
            this._generationDone(data);
        }
    }

    _generateFilename(url) {
        let checksum = GLib.Checksum.new(GLib.ChecksumType.MD5);
        checksum.update(url);

        return `${this._thumbnailsDir}${checksum.get_string()}.png`;
    }
};

