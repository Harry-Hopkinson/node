'use strict';

const {
  ArrayPrototypeJoin,
  FunctionPrototype,
  ObjectAssign,
  ReflectApply,
  SafeMap,
  SafeSet,
} = primordials;

const assert = require('internal/assert');
const path = require('path');
const EventEmitter = require('events');
const { owner_symbol } = require('internal/async_hooks').symbols;
const Worker = require('internal/cluster/worker');
const { internal, sendHelper } = require('internal/cluster/utils');
const cluster = new EventEmitter();
const handles = new SafeMap();
const indexes = new SafeMap();
const noop = FunctionPrototype;

module.exports = cluster;

cluster.isWorker = true;
cluster.isMaster = false; // Deprecated alias. Must be same as isPrimary.
cluster.isPrimary = false;
cluster.worker = null;
cluster.Worker = Worker;

cluster._setupWorker = function () {
  const worker = new Worker({
    id: +process.env.NODE_UNIQUE_ID | 0,
    process: process,
    state: 'online',
  });

  cluster.worker = worker;

  process.once('disconnect', () => {
    worker.emit('disconnect');

    if (!worker.exitedAfterDisconnect) {
      // Unexpected disconnect, primary exited, or some such nastiness, so
      // worker exits immediately.
      process.exit(0);
    }
  });

  process.on('internalMessage', internal(worker, onmessage));
  send({ act: 'online' });

  function onmessage(message, handle) {
    if (message.act === 'newconn') onconnection(message, handle);
    else if (message.act === 'disconnect')
      ReflectApply(_disconnect, worker, [true]);
  }
};

// `obj` is a net#Server or a dgram#Socket object.
cluster._getServer = function (obj, options, cb) {
  let address = options.address;

  // Resolve unix socket paths to absolute paths
  if (
    options.port < 0 &&
    typeof address === 'string' &&
    process.platform !== 'win32'
  )
    address = path.resolve(address);

  const indexesKey = ArrayPrototypeJoin(
    [address, options.port, options.addressType, options.fd],
    ':'
  );

  let indexSet = indexes.get(indexesKey);

  if (indexSet === undefined) {
    indexSet = { nextIndex: 0, set: new SafeSet() };
    indexes.set(indexesKey, indexSet);
  }
  const index = indexSet.nextIndex++;
  indexSet.set.add(index);

  const message = {
    act: 'queryServer',
    index,
    data: null,
    ...options,
  };

  message.address = address;

  // Set custom data on handle (i.e. tls tickets key)
  if (obj._getServerData) message.data = obj._getServerData();

  send(message, (reply, handle) => {
    if (typeof obj._setServerData === 'function')
      obj._setServerData(reply.data);

    if (handle) {
      // Shared listen socket
      shared(reply, { handle, indexesKey, index }, cb);
    } else {
      // Round-robin.
      rr(reply, { indexesKey, index }, cb);
    }
  });

  obj.once('listening', () => {
    cluster.worker.state = 'listening';
    const address = obj.address();
    message.act = 'listening';
    message.port = (address && address.port) || options.port;
    send(message);
  });
};

function removeIndexesKey(indexesKey, index) {
  const indexSet = indexes.get(indexesKey);
  if (!indexSet) {
    return;
  }

  indexSet.set.delete(index);
  if (indexSet.set.size === 0) {
    indexes.delete(indexesKey);
  }
}

// Shared listen socket.
function shared(message, { handle, indexesKey, index }, cb) {
  const key = message.key;
  // Monkey-patch the close() method so we can keep track of when it's
  // closed. Avoids resource leaks when the handle is short-lived.
  const close = handle.close;

  handle.close = function () {
    send({ act: 'close', key });
    handles.delete(key);
    removeIndexesKey(indexesKey, index);
    return ReflectApply(close, handle, arguments);
  };
  assert(handles.has(key) === false);
  handles.set(key, handle);
  cb(message.errno, handle);
}

// Round-robin. Master distributes handles across workers.
function rr(message, { indexesKey, index }, cb) {
  if (message.errno) return cb(message.errno, null);

  let key = message.key;

  function listen(backlog) {
    // TODO(bnoordhuis) Send a message to the primary that tells it to
    // update the backlog size. The actual backlog should probably be
    // the largest requested size by any worker.
    return 0;
  }

  function close() {
    // lib/net.js treats server._handle.close() as effectively synchronous.
    // That means there is a time window between the call to close() and
    // the ack by the primary process in which we can still receive handles.
    // onconnection() below handles that by sending those handles back to
    // the primary.
    if (key === undefined) return;

    send({ act: 'close', key });
    handles.delete(key);
    removeIndexesKey(indexesKey, index);
    key = undefined;
  }

  function getsockname(out) {
    if (key) ObjectAssign(out, message.sockname);

    return 0;
  }

  // Faux handle. Mimics a TCPWrap with just enough fidelity to get away
  // with it. Fools net.Server into thinking that it's backed by a real
  // handle. Use a noop function for ref() and unref() because the control
  // channel is going to keep the worker alive anyway.
  const handle = { close, listen, ref: noop, unref: noop };

  if (message.sockname) {
    handle.getsockname = getsockname; // TCP handles only.
  }

  assert(handles.has(key) === false);
  handles.set(key, handle);
  cb(0, handle);
}

// Round-robin connection.
function onconnection(message, handle) {
  const key = message.key;
  const server = handles.get(key);
  const accepted = server !== undefined;

  send({ ack: message.seq, accepted });

  if (accepted) server.onconnection(0, handle);
}

function send(message, cb) {
  return sendHelper(process, message, null, cb);
}

function _disconnect(primaryInitiated) {
  this.exitedAfterDisconnect = true;
  let waitingCount = 1;

  function checkWaitingCount() {
    waitingCount--;

    if (waitingCount === 0) {
      // If disconnect is worker initiated, wait for ack to be sure
      // exitedAfterDisconnect is properly set in the primary, otherwise, if
      // it's primary initiated there's no need to send the
      // exitedAfterDisconnect message
      if (primaryInitiated) {
        process.disconnect();
      } else {
        send({ act: 'exitedAfterDisconnect' }, () => process.disconnect());
      }
    }
  }

  handles.forEach((handle) => {
    waitingCount++;

    if (handle[owner_symbol]) handle[owner_symbol].close(checkWaitingCount);
    else handle.close(checkWaitingCount);
  });

  handles.clear();
  checkWaitingCount();
}

// Extend generic Worker with methods specific to worker processes.
Worker.prototype.disconnect = function () {
  if (this.state !== 'disconnecting' && this.state !== 'destroying') {
    this.state = 'disconnecting';
    ReflectApply(_disconnect, this, []);
  }

  return this;
};

Worker.prototype.destroy = function () {
  if (this.state === 'destroying') return;

  this.exitedAfterDisconnect = true;
  if (!this.isConnected()) {
    process.exit(0);
  } else {
    this.state = 'destroying';
    send({ act: 'exitedAfterDisconnect' }, () => process.disconnect());
    process.once('disconnect', () => process.exit(0));
  }
};
