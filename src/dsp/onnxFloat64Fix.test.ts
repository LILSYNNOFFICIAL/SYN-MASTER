import test from 'node:test';
import assert from 'node:assert/strict';
import { fixOnnxFloat64 } from './onnxFloat64Fix.ts';

function varint(value: number): number[] {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}
function fieldVarint(number: number, value: number): number[] {
  return [...varint(number * 8), ...varint(value)];
}
function fieldBytes(number: number, value: Uint8Array | number[]): number[] {
  const bytes = Array.from(value);
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
}
function parseFields(bytes: Uint8Array): Array<{ number: number; wire: number; value: number; data: Uint8Array }> {
  const result: Array<{ number: number; wire: number; value: number; data: Uint8Array }> = [];
  let offset = 0;
  const read = (): number => {
    let value = 0;
    let factor = 1;
    for (;;) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * factor;
      if (byte < 0x80) return value;
      factor *= 128;
    }
  };
  while (offset < bytes.length) {
    const tag = read();
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) result.push({ number, wire, value: read(), data: new Uint8Array() });
    else if (wire === 2) {
      const length = read();
      result.push({ number, wire, value: length, data: bytes.slice(offset, offset + length) });
      offset += length;
    } else if (wire === 1) {
      result.push({ number, wire, value: 8, data: bytes.slice(offset, offset + 8) });
      offset += 8;
    } else throw new Error('Unexpected wire type in test parser.');
  }
  return result;
}

test('converts float64 TensorProto raw_data to float32 without altering its value', () => {
  const raw = new Uint8Array(new Float64Array([1.5, -2.25]).buffer);
  const tensor = new Uint8Array([
    ...fieldVarint(2, 11),
    ...fieldBytes(9, raw),
  ]);
  const graph = new Uint8Array(fieldBytes(5, tensor));
  const model = new Uint8Array(fieldBytes(7, graph));
  const fixed = fixOnnxFloat64(model);

  assert.deepEqual(fixed.stats, { tensors: 1, casts: 0, types: 0 });
  const fixedGraph = parseFields(fixed.bytes).find((field) => field.number === 7)!.data;
  const fixedTensor = parseFields(fixedGraph).find((field) => field.number === 5)!.data;
  const tensorFields = parseFields(fixedTensor);
  assert.equal(tensorFields.find((field) => field.number === 2)?.value, 1);
  const floatData = tensorFields.find((field) => field.number === 9)!.data;
  assert.deepEqual(Array.from(new Float32Array(floatData.buffer, floatData.byteOffset, 2)), [1.5, -2.25]);
  assert.equal(tensorFields.some((field) => field.number === 10), false);
});

test('converts packed float64_data into float32 raw_data', () => {
  const packed = new Uint8Array(new Float64Array([0.125, 3.5]).buffer);
  const tensor = new Uint8Array([
    ...fieldVarint(2, 11),
    ...fieldBytes(10, packed),
  ]);
  const fixed = fixOnnxFloat64(new Uint8Array(fieldBytes(7, new Uint8Array(fieldBytes(5, tensor)))));
  assert.equal(fixed.stats.tensors, 1);
  const graph = parseFields(fixed.bytes).find((field) => field.number === 7)!.data;
  const tensorFields = parseFields(parseFields(graph).find((field) => field.number === 5)!.data);
  const raw = tensorFields.find((field) => field.number === 9)!.data;
  assert.deepEqual(Array.from(new Float32Array(raw.buffer, raw.byteOffset, 2)), [0.125, 3.5]);
});

test('leaves models without float64 unchanged', () => {
  const bytes = new Uint8Array(fieldBytes(7, new Uint8Array(fieldBytes(5, new Uint8Array(fieldVarint(2, 1))))));
  const fixed = fixOnnxFloat64(bytes);
  assert.equal(fixed.bytes, bytes);
  assert.deepEqual(fixed.stats, { tensors: 0, casts: 0, types: 0 });
});

test('preserves unrelated 64-bit protobuf varints while rewriting nested float64 tensors', () => {
  const raw = new Uint8Array(new Float64Array([0.5]).buffer);
  const tensor = new Uint8Array([...fieldVarint(2, 11), ...fieldBytes(9, raw)]);
  const largeInt64Field = [0x28, ...Array(9).fill(0xff), 0x01]; // ModelProto.model_version, uint64 max.
  const bytes = new Uint8Array([...largeInt64Field, ...fieldBytes(7, new Uint8Array(fieldBytes(5, tensor)))]);
  const fixed = fixOnnxFloat64(bytes);
  assert.equal(fixed.stats.tensors, 1);
  assert.deepEqual(Array.from(fixed.bytes.subarray(0, largeInt64Field.length)), largeInt64Field);
});

test('rewrites float64 Cast target attributes and graph value types', () => {
  const name = new TextEncoder().encode('to');
  const castAttribute = new Uint8Array([
    ...fieldBytes(1, name),
    ...fieldVarint(3, 11),
  ]);
  const node = new Uint8Array(fieldBytes(5, castAttribute));
  const typeTensor = new Uint8Array(fieldVarint(1, 11));
  const typeProto = new Uint8Array(fieldBytes(1, typeTensor));
  const valueInfo = new Uint8Array(fieldBytes(2, typeProto));
  const graph = new Uint8Array([
    ...fieldBytes(1, node),
    ...fieldBytes(11, valueInfo),
  ]);
  const fixed = fixOnnxFloat64(new Uint8Array(fieldBytes(7, graph)));
  assert.deepEqual(fixed.stats, { tensors: 0, casts: 1, types: 1 });
  const fixedGraph = parseFields(fixed.bytes).find((field) => field.number === 7)!.data;
  const fixedNode = parseFields(fixedGraph).find((field) => field.number === 1)!.data;
  const fixedAttribute = parseFields(fixedNode).find((field) => field.number === 5)!.data;
  assert.equal(parseFields(fixedAttribute).find((field) => field.number === 3)?.value, 1);
  const fixedInfo = parseFields(fixedGraph).find((field) => field.number === 11)!.data;
  const fixedType = parseFields(fixedInfo).find((field) => field.number === 2)!.data;
  const fixedTensorType = parseFields(fixedType).find((field) => field.number === 1)!.data;
  assert.equal(parseFields(fixedTensorType).find((field) => field.number === 1)?.value, 1);
});
