// LazyTransform is a special type of Transform stream that is lazily loaded.
// This is used for performance with bi-API-ship: when two APIs are available
// for the stream, one conventional and one non-conventional.
'use strict';

const { ObjectDefineProperties, ObjectDefineProperty, ObjectSetPrototypeOf } =
  primordials;

const stream = require('stream');

const { getDefaultEncoding } = require('internal/crypto/util');

module.exports = LazyTransform;

function LazyTransform(options) {
  this._options = options;
}
ObjectSetPrototypeOf(LazyTransform.prototype, stream.Transform.prototype);
ObjectSetPrototypeOf(LazyTransform, stream.Transform);

function makeGetter(name) {
  return function () {
    stream.Transform.call(this, this._options);
    this._writableState.decodeStrings = false;

    if (!this._options || !this._options.defaultEncoding) {
      this._writableState.defaultEncoding = getDefaultEncoding();
    }

    return this[name];
  };
}

function makeSetter(name) {
  return function (val) {
    ObjectDefineProperty(this, name, {
      value: val,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };
}

ObjectDefineProperties(LazyTransform.prototype, {
  _readableState: {
    get: makeGetter('_readableState'),
    set: makeSetter('_readableState'),
    configurable: true,
    enumerable: true,
  },
  _writableState: {
    get: makeGetter('_writableState'),
    set: makeSetter('_writableState'),
    configurable: true,
    enumerable: true,
  },
});
