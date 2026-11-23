// Adapted from Gerschwin/steminize src/engine/fixfloat64.ts.
// Copyright (c) 2026 Neil. Licensed under the MIT License; see docs/THIRD_PARTY_NOTICES.md.
// The browser ONNX Runtime build omits float64 kernels. HT-Demucs exports use
// float64 in parts of the inverse STFT graph, so rewrite those protobuf fields
// to float32 while copying the large weight blobs without decoding them.

const DOUBLE = 11;
const FLOAT = 1;
type Chunks = Uint8Array[];
type Handler = (bytes: Uint8Array, start: number, end: number, stats: Float64FixStats) => Chunks | null;

export interface Float64FixStats {
  tensors: number;
  casts: number;
  types: number;
}

interface ProtoField {
  num: number;
  wire: number;
  start: number;
  dataStart: number;
  end: number;
  value: number;
}

function readVarint(bytes: Uint8Array, position: number): [number, number] {
  let value = 0;
  let multiplier = 1;
  let overflow = false;
  for (;;) {
    if (position >= bytes.length) throw new Error('Truncated ONNX protobuf varint.');
    const byte = bytes[position++];
    if (!overflow) {
      const next = value + (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(next)) {
        overflow = true;
        value = 0;
      } else value = next;
    }
    if (byte < 0x80) return [overflow ? Number.POSITIVE_INFINITY : value, position];
    multiplier *= 128;
    if (multiplier > Number.MAX_SAFE_INTEGER) overflow = true;
  }
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Protobuf varint must be a non-negative safe integer.');
  const output: number[] = [];
  while (value >= 0x80) {
    output.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  output.push(value);
  return Uint8Array.from(output);
}

function* fields(bytes: Uint8Array, start: number, end: number): Generator<ProtoField> {
  let position = start;
  while (position < end) {
    const fieldStart = position;
    let tag: number;
    [tag, position] = readVarint(bytes, position);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    if (num === 0) throw new Error('Invalid ONNX protobuf field number.');
    let value = 0;
    let dataStart = position;
    if (wire === 0) [value, position] = readVarint(bytes, position);
    else if (wire === 1) position += 8;
    else if (wire === 5) position += 4;
    else if (wire === 2) {
      [value, position] = readVarint(bytes, position);
      dataStart = position;
      position += value;
    } else throw new Error(`Unsupported ONNX protobuf wire type ${wire}.`);
    if (position > end) throw new Error('ONNX protobuf field extends beyond its parent message.');
    yield { num, wire, start: fieldStart, dataStart, end: position, value };
  }
}

const chunkLength = (chunks: Chunks): number => chunks.reduce((total, chunk) => total + chunk.length, 0);

function message(subMessages: Record<number, () => Handler>): Handler {
  return (bytes, start, end, stats) => {
    const output: Chunks = [];
    let changed = false;
    let copyFrom = start;
    for (const field of fields(bytes, start, end)) {
      const handler = field.wire === 2 ? subMessages[field.num] : undefined;
      if (!handler) continue;
      const rewritten = handler()(bytes, field.dataStart, field.end, stats);
      if (!rewritten) continue;
      changed = true;
      output.push(
        bytes.subarray(copyFrom, field.start),
        encodeVarint(field.num * 8 + 2),
        encodeVarint(chunkLength(rewritten)),
        ...rewritten,
      );
      copyFrom = field.end;
    }
    if (!changed) return null;
    output.push(bytes.subarray(copyFrom, end));
    return output;
  };
}

const tensor: Handler = (bytes, start, end, stats) => {
  let isDouble = false;
  for (const field of fields(bytes, start, end)) {
    if (field.num === 2 && field.wire === 0 && field.value === DOUBLE) isDouble = true;
  }
  if (!isDouble) return null;

  stats.tensors += 1;
  const output: Chunks = [];
  const typedValues: number[] = [];
  let rawData: Uint8Array | null = null;

  for (const field of fields(bytes, start, end)) {
    if (field.num === 2) continue; // data_type is rewritten below.
    if (field.num === 9) rawData = bytes.slice(field.dataStart, field.end);
    else if (field.num === 10 && field.wire === 2) {
      if (field.value % 8 !== 0) throw new Error('Malformed packed float64 TensorProto data.');
      const view = new DataView(bytes.buffer, bytes.byteOffset + field.dataStart, field.value);
      for (let offset = 0; offset < field.value; offset += 8) typedValues.push(view.getFloat64(offset, true));
    } else if (field.num === 10 && field.wire === 1) {
      typedValues.push(new DataView(bytes.buffer, bytes.byteOffset + field.dataStart, 8).getFloat64(0, true));
    } else output.push(bytes.subarray(field.start, field.end));
  }

  let values: Float64Array;
  if (rawData) {
    if (rawData.length % 8 !== 0) throw new Error('Malformed raw float64 TensorProto data.');
    const aligned = new Uint8Array(rawData);
    values = new Float64Array(aligned.buffer, 0, aligned.length / 8);
  } else values = Float64Array.from(typedValues);

  const float32Bytes = new Uint8Array(Float32Array.from(values).buffer);
  output.push(
    encodeVarint(2 * 8),
    encodeVarint(FLOAT),
    encodeVarint(9 * 8 + 2),
    encodeVarint(float32Bytes.length),
    float32Bytes,
  );
  return output;
};

const typeProto: Handler = (bytes, start, end, stats) =>
  message({ 1: () => tensorType, 4: () => elemType, 5: () => mapType, 9: () => elemType })(bytes, start, end, stats);
const elemType: Handler = (bytes, start, end, stats) => message({ 1: () => typeProto })(bytes, start, end, stats);
const mapType: Handler = (bytes, start, end, stats) => message({ 2: () => typeProto })(bytes, start, end, stats);

const tensorType: Handler = (bytes, start, end, stats) => {
  for (const field of fields(bytes, start, end)) {
    if (field.num === 1 && field.wire === 0 && field.value === DOUBLE) {
      stats.types += 1;
      return [
        bytes.subarray(start, field.start),
        encodeVarint(8),
        encodeVarint(FLOAT),
        bytes.subarray(field.end, end),
      ];
    }
  }
  return null;
};

const valueInfo = message({ 2: () => typeProto });
const attribute: Handler = (bytes, start, end, stats) => {
  let name = '';
  for (const field of fields(bytes, start, end)) {
    if (field.num === 1 && field.wire === 2) name = new TextDecoder().decode(bytes.subarray(field.dataStart, field.end));
  }
  const output: Chunks = [];
  let changed = false;
  let copyFrom = start;
  const nested: Record<number, Handler> = { 5: tensor, 6: graph, 10: tensor, 11: graph };
  for (const field of fields(bytes, start, end)) {
    let rewritten: Chunks | null = null;
    if ((name === 'to' || name === 'dtype') && field.num === 3 && field.wire === 0 && field.value === DOUBLE) {
      stats.casts += 1;
      rewritten = [encodeVarint(3 * 8), encodeVarint(FLOAT)];
      output.push(bytes.subarray(copyFrom, field.start), ...rewritten);
    } else if (field.wire === 2 && nested[field.num]) {
      rewritten = nested[field.num](bytes, field.dataStart, field.end, stats);
      if (rewritten) {
        output.push(
          bytes.subarray(copyFrom, field.start),
          encodeVarint(field.num * 8 + 2),
          encodeVarint(chunkLength(rewritten)),
          ...rewritten,
        );
      }
    }
    if (rewritten) {
      changed = true;
      copyFrom = field.end;
    }
  }
  if (!changed) return null;
  output.push(bytes.subarray(copyFrom, end));
  return output;
};

const node = message({ 5: () => attribute });
function graph(bytes: Uint8Array, start: number, end: number, stats: Float64FixStats): Chunks | null {
  return message({
    1: () => node,
    5: () => tensor,
    11: () => valueInfo,
    12: () => valueInfo,
    13: () => valueInfo,
  })(bytes, start, end, stats);
}
const functionProto = message({ 7: () => node });
const model = message({ 7: () => graph, 25: () => functionProto });

/** Rewrites float64 tensors, Cast targets and declared tensor types to float32. */
export function fixOnnxFloat64(bytes: Uint8Array): { bytes: Uint8Array; stats: Float64FixStats } {
  const stats: Float64FixStats = { tensors: 0, casts: 0, types: 0 };
  const chunks = model(bytes, 0, bytes.length, stats);
  if (!chunks) return { bytes, stats };
  const output = new Uint8Array(chunkLength(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: output, stats };
}
