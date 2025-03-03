// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  Array,
  ArrayIsArray,
  ArrayPrototypeForEach,
  Error,
  MathFloor,
  MathMin,
  MathTrunc,
  NumberIsNaN,
  NumberMAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER,
  ObjectCreate,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectSetPrototypeOf,
  StringPrototypeCharCodeAt,
  StringPrototypeReplace,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  StringPrototypeTrim,
  SymbolSpecies,
  SymbolToPrimitive,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeFill,
  TypedArrayPrototypeSet,
  Uint8Array,
  Uint8ArrayPrototype,
} = primordials;

const {
  byteLengthUtf8,
  compare: _compare,
  compareOffset,
  createFromString,
  fill: bindingFill,
  indexOfBuffer,
  indexOfNumber,
  indexOfString,
  swap16: _swap16,
  swap32: _swap32,
  swap64: _swap64,
  kMaxLength,
  kStringMaxLength,
} = internalBinding('buffer');
const {
  getOwnNonIndexProperties,
  propertyFilter: { ALL_PROPERTIES, ONLY_ENUMERABLE },
} = internalBinding('util');
const {
  customInspectSymbol,
  isInsideNodeModules,
  lazyDOMException,
  normalizeEncoding,
  kIsEncodingSymbol,
} = require('internal/util');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isUint8Array,
} = require('internal/util/types');
const { inspect: utilInspect } = require('internal/util/inspect');
const { encodings } = internalBinding('string_decoder');

const {
  codes: {
    ERR_BUFFER_OUT_OF_BOUNDS,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_BUFFER_SIZE,
    ERR_OUT_OF_RANGE,
    ERR_UNKNOWN_ENCODING,
  },
  hideStackFrames,
} = require('internal/errors');
const {
  validateArray,
  validateBuffer,
  validateNumber,
  validateInteger,
  validateString,
} = require('internal/validators');
// Provide validateInteger() but with kMaxLength as the default maximum value.
const validateOffset = (value, name, min = 0, max = kMaxLength) =>
  validateInteger(value, name, min, max);

const {
  FastBuffer,
  markAsUntransferable,
  addBufferPrototypeMethods,
  createUnsafeBuffer,
} = require('internal/buffer');

const { Blob, resolveObjectURL } = require('internal/blob');

FastBuffer.prototype.constructor = Buffer;
Buffer.prototype = FastBuffer.prototype;
addBufferPrototypeMethods(Buffer.prototype);

const constants = ObjectDefineProperties(
  {},
  {
    MAX_LENGTH: {
      value: kMaxLength,
      writable: false,
      enumerable: true,
    },
    MAX_STRING_LENGTH: {
      value: kStringMaxLength,
      writable: false,
      enumerable: true,
    },
  }
);

Buffer.poolSize = 8 * 1024;
let poolSize, poolOffset, allocPool;

const encodingsMap = ObjectCreate(null);
for (let i = 0; i < encodings.length; ++i) encodingsMap[encodings[i]] = i;

function createPool() {
  poolSize = Buffer.poolSize;
  allocPool = createUnsafeBuffer(poolSize).buffer;
  markAsUntransferable(allocPool);
  poolOffset = 0;
}
createPool();

function alignPool() {
  // Ensure aligned slices
  if (poolOffset & 0x7) {
    poolOffset |= 0x7;
    poolOffset++;
  }
}

let bufferWarningAlreadyEmitted = false;
let nodeModulesCheckCounter = 0;
const bufferWarning =
  'Buffer() is deprecated due to security and usability ' +
  'issues. Please use the Buffer.alloc(), ' +
  'Buffer.allocUnsafe(), or Buffer.from() methods instead.';

function showFlaggedDeprecation() {
  if (
    bufferWarningAlreadyEmitted ||
    ++nodeModulesCheckCounter > 10000 ||
    (!require('internal/options').getOptionValue('--pending-deprecation') &&
      isInsideNodeModules())
  ) {
    // We don't emit a warning, because we either:
    // - Already did so, or
    // - Already checked too many times whether a call is coming
    //   from node_modules and want to stop slowing down things, or
    // - We aren't running with `--pending-deprecation` enabled,
    //   and the code is inside `node_modules`.
    return;
  }

  process.emitWarning(bufferWarning, 'DeprecationWarning', 'DEP0005');
  bufferWarningAlreadyEmitted = true;
}

function toInteger(n, defaultVal) {
  n = +n;
  if (
    !NumberIsNaN(n) &&
    n >= NumberMIN_SAFE_INTEGER &&
    n <= NumberMAX_SAFE_INTEGER
  ) {
    return n % 1 === 0 ? n : MathFloor(n);
  }
  return defaultVal;
}

function _copy(source, target, targetStart, sourceStart, sourceEnd) {
  if (!isUint8Array(source))
    throw new ERR_INVALID_ARG_TYPE('source', ['Buffer', 'Uint8Array'], source);
  if (!isUint8Array(target))
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);

  if (targetStart === undefined) {
    targetStart = 0;
  } else {
    targetStart = toInteger(targetStart, 0);
    if (targetStart < 0)
      throw new ERR_OUT_OF_RANGE('targetStart', '>= 0', targetStart);
  }

  if (sourceStart === undefined) {
    sourceStart = 0;
  } else {
    sourceStart = toInteger(sourceStart, 0);
    if (sourceStart < 0)
      throw new ERR_OUT_OF_RANGE('sourceStart', '>= 0', sourceStart);
  }

  if (sourceEnd === undefined) {
    sourceEnd = source.length;
  } else {
    sourceEnd = toInteger(sourceEnd, 0);
    if (sourceEnd < 0)
      throw new ERR_OUT_OF_RANGE('sourceEnd', '>= 0', sourceEnd);
  }

  if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;

  if (sourceStart > source.length) {
    throw new ERR_OUT_OF_RANGE(
      'sourceStart',
      `<= ${source.length}`,
      sourceStart
    );
  }

  return _copyActual(source, target, targetStart, sourceStart, sourceEnd);
}

function _copyActual(source, target, targetStart, sourceStart, sourceEnd) {
  if (sourceEnd - sourceStart > target.length - targetStart)
    sourceEnd = sourceStart + target.length - targetStart;

  let nb = sourceEnd - sourceStart;
  const sourceLen = source.length - sourceStart;
  if (nb > sourceLen) nb = sourceLen;

  if (sourceStart !== 0 || sourceEnd < source.length)
    source = new Uint8Array(source.buffer, source.byteOffset + sourceStart, nb);

  TypedArrayPrototypeSet(target, source, targetStart);

  return nb;
}

/**
 * The Buffer() constructor is deprecated in documentation and should not be
 * used moving forward. Rather, developers should use one of the three new
 * factory APIs: Buffer.from(), Buffer.allocUnsafe() or Buffer.alloc() based on
 * their specific needs. There is no runtime deprecation because of the extent
 * to which the Buffer constructor is used in the ecosystem currently -- a
 * runtime deprecation would introduce too much breakage at this time. It's not
 * likely that the Buffer constructors would ever actually be removed.
 * Deprecation Code: DEP0005
 */
function Buffer(arg, encodingOrOffset, length) {
  showFlaggedDeprecation();
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new ERR_INVALID_ARG_TYPE('string', 'string', arg);
    }
    return Buffer.alloc(arg);
  }
  return Buffer.from(arg, encodingOrOffset, length);
}

ObjectDefineProperty(Buffer, SymbolSpecies, {
  enumerable: false,
  configurable: true,
  get() {
    return FastBuffer;
  },
});

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 */
Buffer.from = function from(value, encodingOrOffset, length) {
  if (typeof value === 'string') return fromString(value, encodingOrOffset);

  if (typeof value === 'object' && value !== null) {
    if (isAnyArrayBuffer(value))
      return fromArrayBuffer(value, encodingOrOffset, length);

    const valueOf = value.valueOf && value.valueOf();
    if (
      valueOf != null &&
      valueOf !== value &&
      (typeof valueOf === 'string' || typeof valueOf === 'object')
    ) {
      return from(valueOf, encodingOrOffset, length);
    }

    const b = fromObject(value);
    if (b) return b;

    if (typeof value[SymbolToPrimitive] === 'function') {
      const primitive = value[SymbolToPrimitive]('string');
      if (typeof primitive === 'string') {
        return fromString(primitive, encodingOrOffset);
      }
    }
  }

  throw new ERR_INVALID_ARG_TYPE(
    'first argument',
    ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'],
    value
  );
};

// Identical to the built-in %TypedArray%.of(), but avoids using the deprecated
// Buffer() constructor. Must use arrow function syntax to avoid automatically
// adding a `prototype` property and making the function a constructor.
//
// Refs: https://tc39.github.io/ecma262/#sec-%typedarray%.of
// Refs: https://esdiscuss.org/topic/isconstructor#content-11
const of = (...items) => {
  const newObj = createUnsafeBuffer(items.length);
  for (let k = 0; k < items.length; k++) newObj[k] = items[k];
  return newObj;
};
Buffer.of = of;

ObjectSetPrototypeOf(Buffer, Uint8Array);

// The 'assertSize' method will remove itself from the callstack when an error
// occurs. This is done simply to keep the internal details of the
// implementation from bleeding out to users.
const assertSize = hideStackFrames((size) => {
  validateNumber(size, 'size');
  if (!(size >= 0 && size <= kMaxLength)) {
    throw new ERR_INVALID_ARG_VALUE.RangeError('size', size);
  }
});

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 */
Buffer.alloc = function alloc(size, fill, encoding) {
  assertSize(size);
  if (fill !== undefined && fill !== 0 && size > 0) {
    const buf = createUnsafeBuffer(size);
    return _fill(buf, fill, 0, buf.length, encoding);
  }
  return new FastBuffer(size);
};

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer
 * instance. If `--zero-fill-buffers` is set, will zero-fill the buffer.
 */
Buffer.allocUnsafe = function allocUnsafe(size) {
  assertSize(size);
  return allocate(size);
};

/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled
 * Buffer instance that is not allocated off the pre-initialized pool.
 * If `--zero-fill-buffers` is set, will zero-fill the buffer.
 */
Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
  assertSize(size);
  return createUnsafeBuffer(size);
};

// If --zero-fill-buffers command line argument is set, a zero-filled
// buffer is returned.
function SlowBuffer(length) {
  assertSize(length);
  return createUnsafeBuffer(length);
}

ObjectSetPrototypeOf(SlowBuffer.prototype, Uint8ArrayPrototype);
ObjectSetPrototypeOf(SlowBuffer, Uint8Array);

function allocate(size) {
  if (size <= 0) {
    return new FastBuffer();
  }
  if (size < Buffer.poolSize >>> 1) {
    if (size > poolSize - poolOffset) createPool();
    const b = new FastBuffer(allocPool, poolOffset, size);
    poolOffset += size;
    alignPool();
    return b;
  }
  return createUnsafeBuffer(size);
}

function fromStringFast(string, ops) {
  const length = ops.byteLength(string);

  if (length >= Buffer.poolSize >>> 1)
    return createFromString(string, ops.encodingVal);

  if (length > poolSize - poolOffset) createPool();
  let b = new FastBuffer(allocPool, poolOffset, length);
  const actual = ops.write(b, string, 0, length);
  if (actual !== length) {
    // byteLength() may overestimate. That's a rare case, though.
    b = new FastBuffer(allocPool, poolOffset, actual);
  }
  poolOffset += actual;
  alignPool();
  return b;
}

function fromString(string, encoding) {
  let ops;
  if (typeof encoding !== 'string' || encoding.length === 0) {
    if (string.length === 0) return new FastBuffer();
    ops = encodingOps.utf8;
    encoding = undefined;
  } else {
    ops = getEncodingOps(encoding);
    if (ops === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
    if (string.length === 0) return new FastBuffer();
  }
  return fromStringFast(string, ops);
}

function fromArrayBuffer(obj, byteOffset, length) {
  // Convert byteOffset to integer
  if (byteOffset === undefined) {
    byteOffset = 0;
  } else {
    byteOffset = +byteOffset;
    if (NumberIsNaN(byteOffset)) byteOffset = 0;
  }

  const maxLength = obj.byteLength - byteOffset;

  if (maxLength < 0) throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');

  if (length === undefined) {
    length = maxLength;
  } else {
    // Convert length to non-negative integer.
    length = +length;
    if (length > 0) {
      if (length > maxLength) throw new ERR_BUFFER_OUT_OF_BOUNDS('length');
    } else {
      length = 0;
    }
  }

  return new FastBuffer(obj, byteOffset, length);
}

function fromArrayLike(obj) {
  if (obj.length <= 0) return new FastBuffer();
  if (obj.length < Buffer.poolSize >>> 1) {
    if (obj.length > poolSize - poolOffset) createPool();
    const b = new FastBuffer(allocPool, poolOffset, obj.length);
    TypedArrayPrototypeSet(b, obj, 0);
    poolOffset += obj.length;
    alignPool();
    return b;
  }
  return new FastBuffer(obj);
}

function fromObject(obj) {
  if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
    if (typeof obj.length !== 'number') {
      return new FastBuffer();
    }
    return fromArrayLike(obj);
  }

  if (obj.type === 'Buffer' && ArrayIsArray(obj.data)) {
    return fromArrayLike(obj.data);
  }
}

// Static methods

Buffer.isBuffer = function isBuffer(b) {
  return b instanceof Buffer;
};

Buffer.compare = function compare(buf1, buf2) {
  if (!isUint8Array(buf1)) {
    throw new ERR_INVALID_ARG_TYPE('buf1', ['Buffer', 'Uint8Array'], buf1);
  }

  if (!isUint8Array(buf2)) {
    throw new ERR_INVALID_ARG_TYPE('buf2', ['Buffer', 'Uint8Array'], buf2);
  }

  if (buf1 === buf2) {
    return 0;
  }

  return _compare(buf1, buf2);
};

Buffer.isEncoding = function isEncoding(encoding) {
  return (
    typeof encoding === 'string' &&
    encoding.length !== 0 &&
    normalizeEncoding(encoding) !== undefined
  );
};
Buffer[kIsEncodingSymbol] = Buffer.isEncoding;

Buffer.concat = function concat(list, length) {
  validateArray(list, 'list');

  if (list.length === 0) return new FastBuffer();

  if (length === undefined) {
    length = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].length) {
        length += list[i].length;
      }
    }
  } else {
    validateOffset(length, 'length');
  }

  const buffer = Buffer.allocUnsafe(length);
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    if (!isUint8Array(buf)) {
      // TODO(BridgeAR): This should not be of type ERR_INVALID_ARG_TYPE.
      // Instead, find the proper error code for this.
      throw new ERR_INVALID_ARG_TYPE(
        `list[${i}]`,
        ['Buffer', 'Uint8Array'],
        list[i]
      );
    }
    pos += _copyActual(buf, buffer, pos, 0, buf.length);
  }

  // Note: `length` is always equal to `buffer.length` at this point
  if (pos < length) {
    // Zero-fill the remaining bytes if the specified `length` was more than
    // the actual total length, i.e. if we have some remaining allocated bytes
    // there were not initialized.
    TypedArrayPrototypeFill(buffer, 0, pos, length);
  }

  return buffer;
};

function base64ByteLength(str, bytes) {
  // Handle padding
  if (StringPrototypeCharCodeAt(str, bytes - 1) === 0x3d) bytes--;
  if (bytes > 1 && StringPrototypeCharCodeAt(str, bytes - 1) === 0x3d) bytes--;

  // Base64 ratio: 3/4
  return (bytes * 3) >>> 2;
}

const encodingOps = {
  utf8: {
    encoding: 'utf8',
    encodingVal: encodingsMap.utf8,
    byteLength: byteLengthUtf8,
    write: (buf, string, offset, len) => buf.utf8Write(string, offset, len),
    slice: (buf, start, end) => buf.utf8Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf8, dir),
  },
  ucs2: {
    encoding: 'ucs2',
    encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2,
    write: (buf, string, offset, len) => buf.ucs2Write(string, offset, len),
    slice: (buf, start, end) => buf.ucs2Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf16le, dir),
  },
  utf16le: {
    encoding: 'utf16le',
    encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2,
    write: (buf, string, offset, len) => buf.ucs2Write(string, offset, len),
    slice: (buf, start, end) => buf.ucs2Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.utf16le, dir),
  },
  latin1: {
    encoding: 'latin1',
    encodingVal: encodingsMap.latin1,
    byteLength: (string) => string.length,
    write: (buf, string, offset, len) => buf.latin1Write(string, offset, len),
    slice: (buf, start, end) => buf.latin1Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfString(buf, val, byteOffset, encodingsMap.latin1, dir),
  },
  ascii: {
    encoding: 'ascii',
    encodingVal: encodingsMap.ascii,
    byteLength: (string) => string.length,
    write: (buf, string, offset, len) => buf.asciiWrite(string, offset, len),
    slice: (buf, start, end) => buf.asciiSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(
        buf,
        fromStringFast(val, encodingOps.ascii),
        byteOffset,
        encodingsMap.ascii,
        dir
      ),
  },
  base64: {
    encoding: 'base64',
    encodingVal: encodingsMap.base64,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: (buf, string, offset, len) => buf.base64Write(string, offset, len),
    slice: (buf, start, end) => buf.base64Slice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(
        buf,
        fromStringFast(val, encodingOps.base64),
        byteOffset,
        encodingsMap.base64,
        dir
      ),
  },
  base64url: {
    encoding: 'base64url',
    encodingVal: encodingsMap.base64url,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: (buf, string, offset, len) =>
      buf.base64urlWrite(string, offset, len),
    slice: (buf, start, end) => buf.base64urlSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(
        buf,
        fromStringFast(val, encodingOps.base64url),
        byteOffset,
        encodingsMap.base64url,
        dir
      ),
  },
  hex: {
    encoding: 'hex',
    encodingVal: encodingsMap.hex,
    byteLength: (string) => string.length >>> 1,
    write: (buf, string, offset, len) => buf.hexWrite(string, offset, len),
    slice: (buf, start, end) => buf.hexSlice(start, end),
    indexOf: (buf, val, byteOffset, dir) =>
      indexOfBuffer(
        buf,
        fromStringFast(val, encodingOps.hex),
        byteOffset,
        encodingsMap.hex,
        dir
      ),
  },
};
function getEncodingOps(encoding) {
  encoding += '';
  switch (encoding.length) {
    case 4:
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      break;
    case 5:
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      break;
    case 7:
      if (
        encoding === 'utf16le' ||
        StringPrototypeToLowerCase(encoding) === 'utf16le'
      )
        return encodingOps.utf16le;
      break;
    case 8:
      if (
        encoding === 'utf-16le' ||
        StringPrototypeToLowerCase(encoding) === 'utf-16le'
      )
        return encodingOps.utf16le;
      break;
    case 6:
      if (encoding === 'latin1' || encoding === 'binary')
        return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      encoding = StringPrototypeToLowerCase(encoding);
      if (encoding === 'latin1' || encoding === 'binary')
        return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      break;
    case 3:
      if (encoding === 'hex' || StringPrototypeToLowerCase(encoding) === 'hex')
        return encodingOps.hex;
      break;
    case 9:
      if (
        encoding === 'base64url' ||
        StringPrototypeToLowerCase(encoding) === 'base64url'
      )
        return encodingOps.base64url;
      break;
  }
}

function byteLength(string, encoding) {
  if (typeof string !== 'string') {
    if (isArrayBufferView(string) || isAnyArrayBuffer(string)) {
      return string.byteLength;
    }

    throw new ERR_INVALID_ARG_TYPE(
      'string',
      ['string', 'Buffer', 'ArrayBuffer'],
      string
    );
  }

  const len = string.length;
  const mustMatch = arguments.length > 2 && arguments[2] === true;
  if (!mustMatch && len === 0) return 0;

  if (!encoding) return mustMatch ? -1 : byteLengthUtf8(string);

  const ops = getEncodingOps(encoding);
  if (ops === undefined) return mustMatch ? -1 : byteLengthUtf8(string);
  return ops.byteLength(string);
}

Buffer.byteLength = byteLength;

// For backwards compatibility.
ObjectDefineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get() {
    if (!(this instanceof Buffer)) return undefined;
    return this.buffer;
  },
});
ObjectDefineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get() {
    if (!(this instanceof Buffer)) return undefined;
    return this.byteOffset;
  },
});

Buffer.prototype.copy = function copy(
  target,
  targetStart,
  sourceStart,
  sourceEnd
) {
  return _copy(this, target, targetStart, sourceStart, sourceEnd);
};

// No need to verify that "buf.length <= MAX_UINT32" since it's a read-only
// property of a typed array.
// This behaves neither like String nor Uint8Array in that we set start/end
// to their upper/lower bounds if the value passed is out of range.
Buffer.prototype.toString = function toString(encoding, start, end) {
  if (arguments.length === 0) {
    return this.utf8Slice(0, this.length);
  }

  const len = this.length;

  if (start <= 0) start = 0;
  else if (start >= len) return '';
  else start |= 0;

  if (end === undefined || end > len) end = len;
  else end |= 0;

  if (end <= start) return '';

  if (encoding === undefined) return this.utf8Slice(start, end);

  const ops = getEncodingOps(encoding);
  if (ops === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);

  return ops.slice(this, start, end);
};

Buffer.prototype.equals = function equals(otherBuffer) {
  if (!isUint8Array(otherBuffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      'otherBuffer',
      ['Buffer', 'Uint8Array'],
      otherBuffer
    );
  }

  if (this === otherBuffer) return true;

  if (this.byteLength !== otherBuffer.byteLength) return false;

  return this.byteLength === 0 || _compare(this, otherBuffer) === 0;
};

let INSPECT_MAX_BYTES = 50;
// Override how buffers are presented by util.inspect().
Buffer.prototype[customInspectSymbol] = function inspect(recurseTimes, ctx) {
  const max = INSPECT_MAX_BYTES;
  const actualMax = MathMin(max, this.length);
  const remaining = this.length - max;
  let str = StringPrototypeTrim(
    StringPrototypeReplace(this.hexSlice(0, actualMax), /(.{2})/g, '$1 ')
  );
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  // Inspect special properties as well, if possible.
  if (ctx) {
    let extras = false;
    const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;
    const obj = ObjectCreate(null);
    ArrayPrototypeForEach(getOwnNonIndexProperties(this, filter), (key) => {
      extras = true;
      obj[key] = this[key];
    });
    if (extras) {
      if (this.length !== 0) str += ', ';
      // '[Object: null prototype] {'.length === 26
      // This is guarded with a test.
      str += StringPrototypeSlice(
        utilInspect(obj, {
          ...ctx,
          breakLength: Infinity,
          compact: true,
        }),
        27,
        -2
      );
    }
  }
  return `<${this.constructor.name} ${str}>`;
};
Buffer.prototype.inspect = Buffer.prototype[customInspectSymbol];

Buffer.prototype.compare = function compare(
  target,
  targetStart,
  targetEnd,
  sourceStart,
  sourceEnd
) {
  if (!isUint8Array(target)) {
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);
  }
  if (arguments.length === 1) return _compare(this, target);

  if (targetStart === undefined) targetStart = 0;
  else validateOffset(targetStart, 'targetStart');

  if (targetEnd === undefined) targetEnd = target.length;
  else validateOffset(targetEnd, 'targetEnd', 0, target.length);

  if (sourceStart === undefined) sourceStart = 0;
  else validateOffset(sourceStart, 'sourceStart');

  if (sourceEnd === undefined) sourceEnd = this.length;
  else validateOffset(sourceEnd, 'sourceEnd', 0, this.length);

  if (sourceStart >= sourceEnd) return targetStart >= targetEnd ? 0 : -1;
  if (targetStart >= targetEnd) return 1;

  return compareOffset(
    this,
    target,
    targetStart,
    sourceStart,
    targetEnd,
    sourceEnd
  );
};

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant if val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
  validateBuffer(buffer);

  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  // Coerce to Number. Values like null and [] become 0.
  byteOffset = +byteOffset;
  // If the offset is undefined, "foo", {}, coerces to NaN, search whole buffer.
  if (NumberIsNaN(byteOffset)) {
    byteOffset = dir ? 0 : buffer.length || buffer.byteLength;
  }
  dir = !!dir; // Cast to bool.

  if (typeof val === 'number')
    return indexOfNumber(buffer, val >>> 0, byteOffset, dir);

  let ops;
  if (encoding === undefined) ops = encodingOps.utf8;
  else ops = getEncodingOps(encoding);

  if (typeof val === 'string') {
    if (ops === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
    return ops.indexOf(buffer, val, byteOffset, dir);
  }

  if (isUint8Array(val)) {
    const encodingVal = ops === undefined ? encodingsMap.utf8 : ops.encodingVal;
    return indexOfBuffer(buffer, val, byteOffset, encodingVal, dir);
  }

  throw new ERR_INVALID_ARG_TYPE(
    'value',
    ['number', 'string', 'Buffer', 'Uint8Array'],
    val
  );
}

Buffer.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
};

Buffer.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
};

Buffer.prototype.includes = function includes(val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1;
};

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill(value, offset, end, encoding) {
  return _fill(this, value, offset, end, encoding);
};

function _fill(buf, value, offset, end, encoding) {
  if (typeof value === 'string') {
    if (offset === undefined || typeof offset === 'string') {
      encoding = offset;
      offset = 0;
      end = buf.length;
    } else if (typeof end === 'string') {
      encoding = end;
      end = buf.length;
    }

    const normalizedEncoding = normalizeEncoding(encoding);
    if (normalizedEncoding === undefined) {
      validateString(encoding, 'encoding');
      throw new ERR_UNKNOWN_ENCODING(encoding);
    }

    if (value.length === 0) {
      // If value === '' default to zero.
      value = 0;
    } else if (value.length === 1) {
      // Fast path: If `value` fits into a single byte, use that numeric value.
      if (normalizedEncoding === 'utf8') {
        const code = StringPrototypeCharCodeAt(value, 0);
        if (code < 128) {
          value = code;
        }
      } else if (normalizedEncoding === 'latin1') {
        value = StringPrototypeCharCodeAt(value, 0);
      }
    }
  } else {
    encoding = undefined;
  }

  if (offset === undefined) {
    offset = 0;
    end = buf.length;
  } else {
    validateOffset(offset, 'offset');
    // Invalid ranges are not set to a default, so can range check early.
    if (end === undefined) {
      end = buf.length;
    } else {
      validateOffset(end, 'end', 0, buf.length);
    }
    if (offset >= end) return buf;
  }

  if (typeof value === 'number') {
    // OOB check
    const byteLen = TypedArrayPrototypeGetByteLength(buf);
    const fillLength = end - offset;
    if (offset > end || fillLength + offset > byteLen)
      throw new ERR_BUFFER_OUT_OF_BOUNDS();

    TypedArrayPrototypeFill(buf, value, offset, end);
  } else {
    const res = bindingFill(buf, value, offset, end, encoding);
    if (res < 0) {
      if (res === -1) throw new ERR_INVALID_ARG_VALUE('value', value);
      throw new ERR_BUFFER_OUT_OF_BOUNDS();
    }
  }

  return buf;
}

Buffer.prototype.write = function write(string, offset, length, encoding) {
  // Buffer#write(string);
  if (offset === undefined) {
    return this.utf8Write(string, 0, this.length);
  }
  // Buffer#write(string, encoding)
  if (length === undefined && typeof offset === 'string') {
    encoding = offset;
    length = this.length;
    offset = 0;

    // Buffer#write(string, offset[, length][, encoding])
  } else {
    validateOffset(offset, 'offset', 0, this.length);

    const remaining = this.length - offset;

    if (length === undefined) {
      length = remaining;
    } else if (typeof length === 'string') {
      encoding = length;
      length = remaining;
    } else {
      validateOffset(length, 'length', 0, this.length);
      if (length > remaining) length = remaining;
    }
  }

  if (!encoding) return this.utf8Write(string, offset, length);

  const ops = getEncodingOps(encoding);
  if (ops === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
  return ops.write(this, string, offset, length);
};

Buffer.prototype.toJSON = function toJSON() {
  if (this.length > 0) {
    const data = new Array(this.length);
    for (let i = 0; i < this.length; ++i) data[i] = this[i];
    return { type: 'Buffer', data };
  }
  return { type: 'Buffer', data: [] };
};

function adjustOffset(offset, length) {
  // Use Math.trunc() to convert offset to an integer value that can be larger
  // than an Int32. Hence, don't use offset | 0 or similar techniques.
  offset = MathTrunc(offset);
  if (offset === 0) {
    return 0;
  }
  if (offset < 0) {
    offset += length;
    return offset > 0 ? offset : 0;
  }
  if (offset < length) {
    return offset;
  }
  return NumberIsNaN(offset) ? 0 : length;
}

Buffer.prototype.subarray = function subarray(start, end) {
  const srcLength = this.length;
  start = adjustOffset(start, srcLength);
  end = end !== undefined ? adjustOffset(end, srcLength) : srcLength;
  const newLength = end > start ? end - start : 0;
  return new FastBuffer(this.buffer, this.byteOffset + start, newLength);
};

Buffer.prototype.slice = function slice(start, end) {
  return this.subarray(start, end);
};

function swap(b, n, m) {
  const i = b[n];
  b[n] = b[m];
  b[m] = i;
}

Buffer.prototype.swap16 = function swap16() {
  // For Buffer.length < 128, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 2 !== 0) throw new ERR_INVALID_BUFFER_SIZE('16-bits');
  if (len < 128) {
    for (let i = 0; i < len; i += 2) swap(this, i, i + 1);
    return this;
  }
  return _swap16(this);
};

Buffer.prototype.swap32 = function swap32() {
  // For Buffer.length < 192, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 4 !== 0) throw new ERR_INVALID_BUFFER_SIZE('32-bits');
  if (len < 192) {
    for (let i = 0; i < len; i += 4) {
      swap(this, i, i + 3);
      swap(this, i + 1, i + 2);
    }
    return this;
  }
  return _swap32(this);
};

Buffer.prototype.swap64 = function swap64() {
  // For Buffer.length < 192, it's generally faster to
  // do the swap in javascript. For larger buffers,
  // dropping down to the native code is faster.
  const len = this.length;
  if (len % 8 !== 0) throw new ERR_INVALID_BUFFER_SIZE('64-bits');
  if (len < 192) {
    for (let i = 0; i < len; i += 8) {
      swap(this, i, i + 7);
      swap(this, i + 1, i + 6);
      swap(this, i + 2, i + 5);
      swap(this, i + 3, i + 4);
    }
    return this;
  }
  return _swap64(this);
};

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

let transcode;
if (internalBinding('config').hasIntl) {
  const { icuErrName, transcode: _transcode } = internalBinding('icu');

  // Transcodes the Buffer from one encoding to another, returning a new
  // Buffer instance.
  transcode = function transcode(source, fromEncoding, toEncoding) {
    if (!isUint8Array(source)) {
      throw new ERR_INVALID_ARG_TYPE(
        'source',
        ['Buffer', 'Uint8Array'],
        source
      );
    }
    if (source.length === 0) return Buffer.alloc(0);

    fromEncoding = normalizeEncoding(fromEncoding) || fromEncoding;
    toEncoding = normalizeEncoding(toEncoding) || toEncoding;
    const result = _transcode(source, fromEncoding, toEncoding);
    if (typeof result !== 'number') return result;

    const code = icuErrName(result);
    // eslint-disable-next-line no-restricted-syntax
    const err = new Error(`Unable to transcode Buffer [${code}]`);
    err.code = code;
    err.errno = result;
    throw err;
  };
}

function btoa(input) {
  // The implementation here has not been performance optimized in any way and
  // should not be.
  // Refs: https://github.com/nodejs/node/pull/38433#issuecomment-828426932
  input = `${input}`;
  for (let n = 0; n < input.length; n++) {
    if (input[n].charCodeAt(0) > 0xff)
      throw lazyDOMException('Invalid character', 'InvalidCharacterError');
  }
  const buf = Buffer.from(input, 'latin1');
  return buf.toString('base64');
}

const kBase64Digits =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function atob(input) {
  // The implementation here has not been performance optimized in any way and
  // should not be.
  // Refs: https://github.com/nodejs/node/pull/38433#issuecomment-828426932
  input = `${input}`;
  for (let n = 0; n < input.length; n++) {
    if (!kBase64Digits.includes(input[n]))
      throw lazyDOMException('Invalid character', 'InvalidCharacterError');
  }
  return Buffer.from(input, 'base64').toString('latin1');
}

module.exports = {
  Blob,
  resolveObjectURL,
  Buffer,
  SlowBuffer,
  transcode,
  // Legacy
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
};

ObjectDefineProperties(module.exports, {
  constants: {
    configurable: false,
    enumerable: true,
    value: constants,
  },
  INSPECT_MAX_BYTES: {
    configurable: true,
    enumerable: true,
    get() {
      return INSPECT_MAX_BYTES;
    },
    set(val) {
      INSPECT_MAX_BYTES = val;
    },
  },
});
