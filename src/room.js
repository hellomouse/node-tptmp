const EventEmitter = require('events');

/** Represents a room */
class Room extends EventEmitter {
  /**
   * Makes a new Room
   * @param {Server} server The server the room belongs to
   * @param {String} name The name of the room
   */
  constructor(server, name) {
    super();
    this.name = name;
    this.clients = new Set();
    this.op = null;
  }
  /**
   * Send data to all clients in a room, optionally excluding a client
   * @param {Buffer} buf Data to send
   * @param {Client} [except] Client to exclude
   */
  send(buf, except = {}) {
    for (let client of this.clients) {
      if (client.id === except.id) continue;
      client.socket.write(buf);
    }
  }
  /**
   * Request a sync for a client
   * @param {Client} client Client requesting sync
   */
  requestSync(client) {
    if (this.clients.size === 0) return; // do nothing
    for (let m of this.clients) {
      if (m.isChat) continue;
      if (client.id === m.id) continue;
      m.socket.write(Buffer.from([128, client.id]));
      return;
    }
  }
  /**
   * Join a client to the room
   * Should not be called directly, call Client.prototype.join instead
   * @param {Client} client The client to join
   */
  join(client) {
    if (this.clients.has(client)) return;
    if (this.clients.size === 0) this.op = client.id;
    this.emit('join', client);

    client.socket.write(Buffer.from([16, this.clients.size]));
    for (let m of this.clients) {
      client.socket.write(Buffer.from([m.id, ...Buffer.from(m.nick), 0]));
    }
    for (let m of this.clients) {
      for (let i = 0; i < m.brush; i++) {
        client.socket.write(Buffer.from([35, m.id]));
      }
      client.socket.write(Buffer.from([34, m.id, ...m.brushSize]));
      for (let i = 0; i < 4; i++) {
        client.socket.write(Buffer.from([37, m.id, ...m.brushSelection[i]]));
      }
      client.socket.write(Buffer.from([
        38, m.id, ...Buffer.from(m.replaceMode)
      ]));
      client.socket.write(Buffer.from([65, m.id, ...m.deco]));
    }
    this.send(Buffer.from([17, client.id, ...Buffer.from(client.nick), 0]),
      client);
    this.requestSync(client);
    this.clients.add(client);
  }
  /**
   * Part a client from the room
   * Should not be called directly, call Client.prototype.part instead
   * @param {Client} client The client to part
   */
  part(client) {
    this.emit('part', client);
    this.clients.delete(client);
    if (this.op === client.id) this.op = this.clients.values().next().value;
    this.send(Buffer.from([18, client.id]), client);
  }
}

module.exports = Room;
