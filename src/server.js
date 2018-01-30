const net = require('net');
const EventEmitter = require('events');
const Client = require('./client');
const Room = require('./room');

let noOp = () => true;

/** Class representing the tptmp server */
class TPTMPServer extends EventEmitter {
  /**
   * Creates a new Server instance
   * @param {Object} opts Options for the server
   * @param {String} [opts.host] Host for the server to listen on
   * @param {Number} [opts.port=34403] Port for the server to listen on
   */
  constructor(opts) {
    super();
    this.opts = Object.assign({
      host: null,
      port: 34403,
    }, opts);
    this.clients = new Map();
    this.rooms = new Map();
    this.hooks = {
      connect: noOp,
      join: noOp,
      message: noOp
    };
    this.tcpServer = net.createServer(this._connectionHandler.bind(this));
  }
  /**
   * Start listening for connectoins
   * @param {Number} [port] Port for the server to bind to
   * @param {Number} [host] Host for the server to bind to
   */
  listen(port, host) {
    port = port || this.opts.port;
    host = host || this.opts.host;
    this.tcpServer.listen(port, host);
  }
  /**
   * Handles incoming connections to the server
   * @param {Socket} socket Incoming connection
   */
  _connectionHandler(socket) {
    if (this.clients.size >= 255) {
      socket.write(`\x00Server is full (${this.clients.size}/255)\x00`);
      socket.end();
      return;
    }
    let client = new Client(this, socket);
    this.clients.set(client.id, client);
  }
  /**
   * Join a client to a room
   * Should not be called directly, call Client.prototype.join instead
   * @param {Client} client The client to join
   * @param {String} r The name of the room to join
   * @return {Room} THe room the client joined
   */
  join(client, r) {
    let room = this.rooms.get(r);
    if (!room) {
      room = new Room(this, r);
      this.rooms.set(r, room);
      this.emit('roomCreate', room);
    }
    room.join(client);
    this.emit('join', client, room);
    return room;
  }
  /**
   * Part a client from a room
   * Should not be called directly, call Client.prototype.part instead
   * @param {Client} client The client to part
   * @param {Room} room The room the client is to part
   */
  part(client, room) {
    this.emit('part', client, room);
    room.part(client);
    if (room.clients.size === 0) {
      room.emit('delete');
      this.emit('roomDelete', room);
      this.rooms.delete(room.name);
    }
  }
  /**
   * Disconnect a client
   * Should not be called directly, call Client.prototype.disconnect instead
   * @param {Client} client The client to disconnect
   * @param {String} reason The reason the client disconnected
   */
  disconnect(client, reason) {
    this.emit('disconnect', client, reason);
    this.clients.delete(client.id);
  }
}

module.exports = TPTMPServer;
