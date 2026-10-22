import net from "node:net";

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  put(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  get() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

export class TorTCPSocket {
  constructor(hostname, port, socksHost, socksPort) {
    this.hostname = hostname;
    this.port = port;
    this.socksHost = socksHost;
    this.socksPort = socksPort;
    this.socket = null;
    this.dataQueue = new AsyncQueue();
    this.pendingData = Buffer.alloc(0);
    this.paused = false;
  }

  async readBytes(length) {
    while (this.pendingData.length < length) {
      const data = await this.dataQueue.get();
      if (data === null) throw new Error("Tor SOCKS connection closed during handshake");
      this.pendingData = Buffer.concat([this.pendingData, data]);
    }
    const result = this.pendingData.subarray(0, length);
    this.pendingData = this.pendingData.subarray(length);
    return result;
  }

  async connect() {
    const socket = new net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);

    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          socket.off("connect", onConnect);
          reject(error);
        };
        const onConnect = () => {
          socket.off("error", onError);
          resolve();
        };
        socket.once("error", onError);
        socket.once("connect", onConnect);
        socket.connect(this.socksPort, this.socksHost);
      });

      socket.on("data", data => this.dataQueue.put(data));
      socket.on("close", () => this.dataQueue.close());
      socket.on("error", () => this.dataQueue.close());

      socket.write(Buffer.from([5, 1, 0]));
      const greeting = await this.readBytes(2);
      if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("Tor SOCKS5 does not allow unauthenticated connections");

      const host = Buffer.from(this.hostname);
      if (host.length > 255) throw new Error("Destination hostname exceeds SOCKS5 limits");
      const port = Buffer.alloc(2);
      port.writeUInt16BE(this.port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port]));

      const response = await this.readBytes(4);
      if (response[0] !== 5 || response[1] !== 0) throw new Error(`Tor SOCKS5 connection failed with status ${response[1]}`);
      const addressLength = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await this.readBytes(1))[0] : 0;
      if (!addressLength) throw new Error("Tor SOCKS5 returned an invalid address type");
      await this.readBytes(addressLength + 2);
    } catch (error) {
      socket.destroy();
      this.socket = null;
      throw error;
    }
  }

  recv() {
    return this.dataQueue.get();
  }

  send(data) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("Tor SOCKS connection is closed"));
      this.socket.write(data, error => (error ? reject(error) : resolve()));
    });
  }

  close() {
    this.dataQueue.close();
    this.socket?.end();
    this.socket = null;
  }

  pause() {
    if (this.dataQueue.items.length >= 128) {
      this.socket?.pause();
      this.paused = true;
    }
  }

  resume() {
    if (this.paused && this.socket) {
      this.socket.resume();
      this.paused = false;
    }
  }
}
