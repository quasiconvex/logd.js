var WebSocket = require('ws')
var Sun = require('sky/sun')
var Loom = require('./loom')
var Cage = Sun.Cage, up = Sun.up, def = Sun.def;

var Client = module.exports = Sun.cls(function Client(opts) {
  var self = Cage.call(this)
  var opts = up({secure: true, defrag: {edit: true}}, opts)
  var api = opts.api || 'logbased.io'
  var domain = opts.domain;
  if (domain == undefined)
    throw(new Error("Must specify 'domain'"))
  this.secure = opts.secure;
  this.authority = 'd-' + domain + '.' + api;
  this.reconnect = opts.reconnect || 30000;
  this.delegate = opts.delegate || {}
  this.storage = opts.storage || localStorage;
  this.queue = opts.queue || []
  this.saver = Sun.throttle(this.save.bind(this), 1000)
  this.load()
  if (opts.defrag)
    this.fromHash(opts.defrag)
}, new Cage, {
  load: function () {
    var storage = this.storage;
    this.updated = JSON.parse(storage.updated || '0')
    this.session = JSON.parse(storage.session || '{}')
    this.profiles = JSON.parse(storage.profiles || '[]')
    this.settings = JSON.parse(storage.settings || '{}')
    return this;
  },

  save: function () {
    var storage = this.storage;
    storage.updated = JSON.stringify(this.updated)
    storage.session = JSON.stringify(this.session)
    storage.profiles = JSON.stringify(this.profiles)
    storage.settings = JSON.stringify(this.settings)
    return this;
  },

  init: function () {
    if (!this.session.token)
      setTimeout(this.change.bind(this, 'authed', false))
    return this.attemptConnection()
  },

  setTimer: function (fun, after) {
    if (this.timer)
      this.timer = clearTimeout(this.timer)
    if (after)
      this.timer = setTimeout(fun, after)
  },

  /*
   * Entry point for logging in the user...
   * Use alias if already connected (but default should just work)
   */
  login: function (opts, fun) {
    var fun = fun || function (r) { document.location.href = r.redirect }
    var opts = up({}, opts)
    var provider = opts.provider;
    if (provider == undefined)
      throw(new Error("Must specify 'provider'"))
    var params = def(opts.params, {})
    var alias = def(opts.alias, !!this.session.token)
    if (alias)
      this.send({
        what: 'initiate alias',
        provider: provider,
        params: params,
      }, fun)
    else
      fun({
        redirect: Sun.URL.format({
          scheme: this.secure ? 'https' : 'http',
          authority: this.authority,
          path: '/login/initiate/' + provider,
          query: Sun.form.encode(params)
        })
      })
  },

  /*
   * Log the user out completely
   */
  logout: function () {
    this.updated = 0;
    this.session = {}
    this.profiles = []
    this.settings = {}
    this.change('authed', false)
    this.saver()
    this.disconnect()
  },

  fromHash: function (opts) {
    var frag = Sun.form.decode(window.location.hash.substr(1))
    var logd = Sun.pop(frag, 'logd')
    if (logd && !this.session.token)
      this.session = JSON.parse(atob(logd))
    if (opts.edit)
      window.location.hash = Sun.form.encode(frag)
  },

  attemptConnection: function () {
    if (this.session.token && !this.socket) {
      var self = this;
      var scheme = this.secure ? 'wss' : 'ws'
      var url = Sun.URL.format({
        scheme: this.secure ? 'wss' : 'ws',
        authority: this.authority,
        path: '/connect'
      })
      this.socket = new WebSocket(url)
      this.socket.onopen = function () {
        self.busy = false;
        self.last = 0;
        self.retries = 0;
        self.cast(self.session)
        self.sendNext()
      }
      this.socket.onclose = function () {
        self.socket = null;
        self.change('connected', false)
        self.retries++;
        self.setTimer(self.attemptConnection.bind(self), self.reconnect)
      }
      this.socket.onerror = function (error) {
        console.error(error)
      }
      this.socket.onmessage = function (message) {
        self.receivedData(message.data)
      }
    }
    return this;
  },

  connect: function (session) {
    if (session)
      this.session = session
    return this.attemptConnection()
  },

  disconnect: function (reconnect) {
    this.reconnect = reconnect;
    this.socket && this.socket.close()
  },

  cast: function (json) {
    this.socket.send(JSON.stringify(json))
  },

  /*
   * The universal API
   */
  send: function (value, callback) {
    this.queue.push([value, callback])
    this.sendNext()
  },

  sendNext: function () {
    if (this.busy)
      return;
    if (this.connected) {
      var next = this.queue[0]
      if (next) {
        this.busy = true;
        this.last++;
        this.callback = next[1]
        this.cast(['send', this.last, next[0]])
      } else {
        this.busy = false;
      }
    } else {
      this.attemptConnection()
    }
  },

  receivedData: function (data) {
    var json = JSON.parse(data)
    switch (json[0]) {
    case 'connected':
      console.debug("Successfully authenticated", json)
      this.change('session', up(this.session, json[1]))
      this.change('connected', true)
      this.change('authed', true)
      this.cast(['ping'])
      this.sendNext()
      break;
    case 'pong':
      this.setTimer(this.cast.bind(this, ['ping']), json[1])
      break;
    case 'error':
      switch (json[1]) {
      case 'init':
        console.error("Bad session data", json)
        break;
      case 'session':
        console.warn("Session invalidated", json)
        this.change('session', {})
        this.change('authed', false)
        break;
      case 'conn':
        console.warn("Failed to establish connection", json)
        this.change('session', Sun.select(this.session, ['identity', 'token']))
        break;
      default:
        console.error("Unexpected error", json)
        this.queue.shift()
        this.sendNext()
        break;
      }
      break;
    case 'reply':
      this.callback && this.callback(json[2])
      this.busy = false;
      this.queue.shift()
      this.sendNext()
      break;
    case 'catchup':
    case 'forward':
      var self = this, delegate = this.delegate;
      this.session.since = json[1].reduce(function (since, item) {
        var message = item[0], locus = item[1]
        if (self.handleBuiltin(message) && delegate.handleMessage)
          delegate.handleMessage(message)
        return Loom.edgeHull(since, Loom.locusAfter(locus))
      }, this.session.since)
      break;
    default:
      console.warn("Received unrecognized packet", json)
      break;
    }
    this.updated = new Date()
    this.saver()
  },

  handleBuiltin: function (message) {
    switch (message.type) {
    case 'login':
      Sun.set(this.profiles, message.session.identity, message.profile)
      this.defaultSettings(message.profile)
      this.change('user', message.profile)
      break;
    default:
      break;
    }
    return true;
  },

  defaultSettings: function (profile, settings) {
    var settings = settings || this.settings;
    var defaults = function (over) {
      var s = ['name',
               'first_name',
               'last_name',
               'email',
               'phone',
               'locale',
               'location',
               'birthday',
               'gender',
               'timezone',
               'zoneinfo'].reduce(function (s, k) {
                 if (s[k] == undefined) {
                   var o = over[k], u = profile.userinfo;
                   if (o == undefined) {
                     var v = u[k]
                     if (v == undefined) {
                       switch (k) {
                       case 'first_name':
                         v = s.name && s.name.split(/\s+/)[0]
                         break;
                       case 'last_name':
                         v = s.name && s.name.split(/\s+/)[1]
                         break;
                       }
                     }
                     s[k] = v;
                   } else {
                     s[k] = o instanceof Function ? o(u, s) : Sun.lookup(u, o)
                   }
                 }
                 return s;
               }, settings)
      if (s.name == null)
        s.name = (s.first_name && s.last_name ?
                  s.first_name + ' ' + s.last_name :
                  s.first_name)
    }
    switch (profile.provider) {
    case 'facebook':
      defaults({
        location: ['location', 'name']
      })
      break;
    case 'google':
      defaults({
        first_name: 'given_name',
        last_name: 'family_name',
        phone: 'phone_number',
        location: ['address', 'formatted']
      });
      break;
    case 'github':
      defaults({})
      break;
    case 'linkedin':
      defaults({
        name: 'formattedName',
        first_name: 'firstName',
        last_name: 'lastName',
        email: 'emailAddress',
        location: ['location', 'name']
      })
      break;
    case 'twitter':
      defaults({
        timezone: function (u) { return u.utc_offset == null ? null : u.utc_offset / 3600 }
      })
      break;
    default:
      defaults({})
    }
    return settings;
  }
})
