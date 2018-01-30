const EventEmitter = require('events');
const constants = require('./constants');

/** Represents a tptmp client */
class Client extends EventEmitter {
  /**
   * Creates a new Client object
   * @param {Server} server The server the client belongs to
   * @param {Socket} socket The socket of the client
   */
  constructor(server, socket) {
    super();
    this.server = server;
    this.socket = socket;
    this.connected = true;
    this.nick = null;
    this.version = [];
    this.room = null;
    this.brush = 0;
    this.brushSize = Buffer.from([4, 4]);
    this.brushSelection = [
      Buffer.from([0, 1]), Buffer.from([64, 0]), Buffer.from([128, 0]),
      Buffer.from([192, 0])
    ];
    this.replaceMode = '0';
    this.deco = Buffer.from([0, 0, 0, 0]);
    this.isChat = false;

    // find an id
    for (let i = 0; i < 256; i++) {
      if (!this.server.clients.has(i)) {
        this.id = i;
        break;
      }
    }

    this._data = Buffer.alloc(0);
    this._initial = true;
    // timeout after 90 seconds
    // the client should send a ping every minute
    this.socket.setTimeout(90 * 1000);
    this.socket.on('timeout', () => this.disconnect('Ping timeout'))
    .on('error', err => this.disconnect(err.message))
    .on('end', () => this.disconnect('Client left'))
    .on('close', hadError => this.connected = false);
    this.dataHandler();
  }
  /**
   * Read socket until null byte
   * @return {Promise} Promise resolving to the data
   */
  readUntilNull() {
    let data = [];
    return new Promise((resolve, reject) => {
      let handler = () => {
        let d = this.socket.read(1);
        while (d) {
          if (d[0] === 0) {
            this.socket.removeListener('readable', handler);
            return resolve(Buffer.concat(data));
          }
          data.push(d);
          d = this.socket.read(1);
        }
      };
      this.socket.on('readable', handler);
      handler();
    });
  }
  /**
   * Read number of bytes from the socket
   * @param {Number} n Number of bytes to read
   * @return {Promise} Promise resolving to the data
   */
  readBytes(n) {
    return new Promise((resolve, reject) => {
      let handler = () => {
        let d = this.socket.read(n);
        if (d) {
          this.socket.removeListener('readable', handler);
          return resolve(d);
        }
      };
      this.socket.on('readable', handler);
      handler();
    });
  }
  /**
   * Handles data input
   */
  async dataHandler() {
    // because of the way the protocol is designed it is a whole lot
    // easier to just use an async while loop rather than trying to
    // process a stream
    let buf = await this.readUntilNull();
    this._initial = false;
    this.version = [buf[0], buf[1], buf[2]];
    let [major, minor, scriptVer] = buf;
    if (
      major < constants.version.MAJOR_MIN ||
      (major === constants.version.MAJOR_MIN &&
      minor < constants.version.MINOR_MIN)
    ) {
      this.socket.write(`\x00Client out of date (expected at least ` +
        `${constants.version.MAJOR_MIN}.${constants.version.MINOR_MIN})\x00`);
      this.disconnect(`Old version: ${major}.${minor}`);
      return;
    } else if (
      major > constants.version.MAJOR_MAX ||
      (major === constants.version.MAJOR_MAX &&
      minor > constants.version.MINOR_MAX)
    ) {
      this.socket.write(`\x00Client too new (expected at most ` +
        `${constants.version.MAJOR_MAX}.${constants.version.MINOR_MAX})\x00`);
      this.disconnect(`New version: ${major}.${minor}`);
      return;
    } else if (scriptVer !== constants.version.SCRIPT) {
      this.socket.write(`\x00Script version mismatch (expected ` +
        `${this.constants.SCRIPT})\x00`);
      this.disconnect(`Script version mismatch: ${scriptVer}`);
      return;
    }
    let nick = buf.slice(3).toString();
    this.nick = nick;
    if (!nick.match(/^[\w-_]+$/)) {
      this.socket.write(`\x00Bad nickname\x00`);
      this.disconnect(`Invalid nickname`);
      return;
    } else if (nick.length > 32) {
      this.socket.write(`\x00Nick too long\x00`);
      this.nick = this.nick.slice(0, 64); // for logging purposes
      this.disconnect(`Nick was too long (${nick.length})`);
      return;
    }
    for (let client of this.server.clients) {
      if (nick === client[1].nick && client[0] !== this.id) {
        // this message is hardcoded into the client
        this.socket.write(`\x00This nick is already on the server\x00`);
        this.disconnect(`Nick taken (${nick})`);
        return;
      }
    }
    this.socket.write('\x01');
    this.emit('identified');
    this.server.emit('newClient', this);
    if (!this.server.hooks.connect(this)) return;
    this.join('null');

    // main loop
    while (this.connected) {
      let cmd = (await this.readBytes(1))[0];
      switch (cmd) {
        case 16: { // join
          let r = (await this.readUntilNull()).toString();
          if (!r.match(/^[\w-_]+$/) || r.length > 32) {
            this.serverMessage('Invalid room name');
            break;
          }
          if (!this.server.hooks.join(this, r)) break;
          this.part();
          this.join(r);
          break;
        }
        case 19: { // message
          let message = (await this.readUntilNull()).toString();
          if (!message.match(/^[ -~]*$/)) {
            this.serverMessage('Invalid characters in message');
            break;
          } else if (message.length > 200) {
            this.serverMessage('Message too long');
            break;
          }
          if (!this.server.hooks.message(this, message)) break;
          this.server.emit('chat', this, message);
          this.room.send(Buffer.from([19, this.id, ...Buffer.from(message), 0]),
            this);
          break;
        }
        case 20: { // emote
          let message = (await this.readUntilNull()).toString();
          if (!message.match(/^[ -~]*$/)) {
            this.serverMessage('Invalid characters in message');
            break;
          } else if (message.length > 200) {
            this.serverMessage('Message too long');
            break;
          }
          if (!this.server.hooks.message(this, message)) break;
          this.server.emit('chat', this, '* ' + message);
          this.room.send(Buffer.from([20, this.id, ...Buffer.from(message), 0]),
            this);
          break;
        }
        case 21: { // kick
          let nick = (await this.readUntilNull()).toString();
          let reason = (await this.readUntilNull()).toString();
          if (!reason.match(/^[ -~]*$/)) {
            this.serverMessage('Invalid characters in kick reason');
            break;
          } else if (reason.length > 200) {
            this.serverMessage('Kick reason too long');
            break;
          } else if (this.room.name === 'null') {
            this.serverMessage('You can\'t kick people from the lobby');
            break;
          } else if (this.room.op !== this.id) {
            this.serverMessage('You can\'t kick people from here');
            break;
          }
          for (let c of this.room.clients) {
            if (c.nick === nick) {
              c.kick(this, reason || undefined);
              break;
            }
          }
          break;
        }
        case 2: { // ping
          // nothing to do here
          break;
        }
        case 32: { // mouse position
          let data = await this.readBytes(3);
          this.sendToRoom(Buffer.from([32, this.id, ...data]));
          break;
        }
        case 33: { // mouse click
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([33, this.id, ...data]));
          break;
        }
        case 34: { // brush size
          let data = await this.readBytes(2);
          this.brushSize = data;
          this.sendToRoom(Buffer.from([34, this.id, ...data]));
          break;
        }
        case 35: { // brush shape change
          this.brush = this.brush % 3 + 1;
          this.sendToRoom(Buffer.from([35, this.id]));
          break;
        }
        case 36: { // modifier
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([36, this.id, ...data]));
          break;
        }
        case 37: { // selected element
          let data = await this.readBytes(2);
          let button = Math.floor(data[0] / 64);
          if (data[0] !== 194 && data[1] !== 195) {
            this.brushSelection[button + 1] = data;
            this.sendToRoom(Buffer.from([37, this.id, ...data]));
          } else {
            this.isChat = true;
          }
          break;
        }
        case 38: { // replace mode
          let data = await this.readBytes(1);
          this.replaceMode = data;
          this.sendToRoom(Buffer.from([38, this.id, ...data]));
          break;
        }
        case 48: { // cmode default
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([48, this.id, ...data]));
          break;
        }
        case 49: { // pause
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([49, this.id, ...data]));
          break;
        }
        case 50: { // step frame
          this.sendToRoom(Buffer.from([50, this.id]));
          break;
        }
        case 51: { // deco mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([51, this.id, ...data]));
          break;
        }
        case 52: { // HUD mode, no longer used
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([52, this.id, ...data]));
          break;
        }
        case 53: { // ambient heat mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([53, this.id, ...data]));
          break;
        }
        case 54: { // newtonian gravity mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([54, this.id, ...data]));
          break;
        }
        case 55: { // debug mode, not used and cannot be implemented
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([55, this.id, ...data]));
          break;
        }
        case 56: { // legacy heat mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([56, this.id, ...data]));
          break;
        }
        case 57: { // water equalization
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([57, this.id, ...data]));
          break;
        }
        case 58: { // gravity mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([58, this.id, ...data]));
          break;
        }
        case 59: { // air mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([59, this.id, ...data]));
          break;
        }
        case 60: { // clear sparks
          this.sendToRoom(Buffer.from([60, this.id]));
          break;
        }
        case 61: { // clear pressure
          this.sendToRoom(Buffer.from([61, this.id]));
          break;
        }
        case 62: { // invert pressure
          this.sendToRoom(Buffer.from([62, this.id]));
          break;
        }
        case 63: { // clear simulation
          this.sendToRoom(Buffer.from([63, this.id]));
          break;
        }
        case 64: { // manual graphics in graphics menu
          let data = await this.readBytes(3);
          this.sendToRoom(Buffer.from([64, this.id, ...data]));
          break;
        }
        case 65: { // deco color select
          let data = await this.readBytes(4);
          this.deco = data;
          this.sendToRoom(Buffer.from([65, this.id, ...data]));
          break;
        }
        case 66: { // stamp
          let data = await this.readBytes(6);
          let location = data.slice(0, 3);
          let size = (data[3] << 16) + (data[4] << 8) + data[5];
          let stamp = await this.readBytes(size);
          this.sendToRoom(Buffer.from([
            66, this.id, ...location, data[3], data[4], data[5], ...stamp
          ]));
          break;
        }
        case 67: { // clear area
          let data = await this.readBytes(6);
          this.sendToRoom(Buffer.from([67, this.id, ...data]));
          break;
        }
        case 68: { // edge mode
          let data = await this.readBytes(1);
          this.sendToRoom(Buffer.from([68, this.id, ...data]));
          break;
        }
        case 69: { // load save id
          let data = await this.readBytes(3);
          this.sendToRoom(Buffer.from([69, this.id, ...data]));
          break;
        }
        case 70: { // reload save
          this.sendToRoom(Buffer.from([70, this.id]));
          break;
        }
        case 128: { // sync reply
          let data = await this.readBytes(4);
          let id = data[0];
          let size = (data[1] << 16) + (data[2] << 8) + data[3];
          let stamp = await this.readBytes(size);
          let client = this.server.clients.get(id);
          if (!client) break; // already disconnected or this is junk
          client.socket.write(Buffer.from([129, ...data.slice(1), ...stamp]));
          break;
        }
        case 130: { // sync properties reply
          let data = await this.readBytes(3);
          let client = this.server.clients.get(data[0]);
          if (!client) break; // already disconnected, or junk
          let command = data[1];
          if (!constants.VALID_130.includes(command)) break; // this is bogus
          client.socket.write(Buffer.from([command, this.id, data[2]]));
          break;
        }
      }
    }
  }
  /**
   * Disconnect a client
   * @param {String} [reason=Lost connection] Reason for disconnection
   */
  disconnect(reason = 'Lost connection') {
    this.emit('disconnect', reason);
    this.server.disconnect(this, reason);
    this.socket.end();
    if (this.room) this.part();
  }
  /**
   * Join the client to a room
   * @param {String} r Name of room
   */
  join(r) {
    let room = this.server.join(this, r);
    this.room = room;
    this.emit('join', r);
  }
  /**
   * Part the client from the current room
   * Whatever calls this function must also join the client back to the room
   * 'null' if the client is still connected to the server
   */
  part() {
    this.emit('part');
    this.server.part(this, this.room);
    this.room = null;
  }
  /**
   * Kick a client from a room
   * @param {Client} source The client that issued the kick
   * @param {String} [reason=No reason given] Reason for the disconnection
   */
  kick(source, reason = 'No reason given') {
    let message = `You were kicked by ${source.nick} (${reason})`;
    this.serverMessage(message, 255, 50, 50);
    this.emit('kicked', source, reason);
    this.disconnect(`Kicked by ${source.nick} (${reason})`);
  }
  /**
   * Send a server message to the client
   * @param {String} message The message to send
   * @param {Number} [r=127] Red RGB value of message
   * @param {Number} [g=255] Green RGB value of message
   * @param {Number} [b=255] Blue RGB value of message
   */
  serverMessage(message, r = 127, g = 255, b = 255) {
    this.socket.write(Buffer.from([22, ...Buffer.from(message), 0, r, g, b]));
  }
  /**
   * Send a message to the room
   * @param {String} message The message to send
   * @param {Boolean} [includeSelf=false] Whether to send the message to self
   */
  sendToRoom(message, includeSelf = false) {
    if (this.room) this.room.send(message, includeSelf ? {} : this);
  }
}

module.exports = Client;
