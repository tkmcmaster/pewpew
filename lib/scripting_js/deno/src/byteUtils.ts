import { IPCMessage, JsonType, HeaderBuffer, Header, BodyBuffer } from "./message.ts";

export function decodeString(bytes: Uint8Array): string {
  return new TextDecoder("utf8").decode(bytes);
}

export function encodeString(str: string, into: Uint8Array, position: number = 0): Uint8Array {
  // if the `into` parameter is big enough, use it instead of allocating another Uint8Array
  if (str.length * 3 <= into.byteLength - position + 1) {
    const { written } = new TextEncoder().encodeInto(str, into.subarray(position - 1));
    return into.subarray(0, written! + position - 1);
  } else {
    const bytes = new TextEncoder().encode(str);
    return bytes;
  }
}

export function decodeUint(bytes: Uint8Array, width: 8 | 16 | 32): number {
  const dataView = new DataView(bytes.buffer);
  if (width == 8) {
    return dataView.getUint8(0);
  } else if (width == 16) {
    return dataView.getUint16(0);
  } else {
    return dataView.getUint32(0);
  }
}

export function decodeBigUint(bytes: Uint8Array, width: 55): bigint {
  const dataView = new DataView(bytes.buffer);
  if (bytes.byteLength == 7) {
    // get the first 4 bytes
    const first = dataView.getUint32(0);
    // get the next 2 bytes
    const middle = dataView.getUint16(4);
    // get the last byte
    const last = dataView.getUint8(6);
    // put them all together
    return (BigInt(first) << 24n) | (BigInt(middle) << 8n) | BigInt(last);
  } else {
    throw new Error(`decoding bigUint not supported for Uint8Arrays that are not 7 bytes`);
  }
}

export function encodeUint(int: number, width: 8 | 16 | 32, into?: Uint8Array): Uint8Array {
  const written = width / 8;
  let buffer = into && into.byteLength >= written ? into : new Uint8Array(written);
  const dataView = new DataView(buffer.buffer);
  if (width == 8) {
    dataView.setUint8(0, int);
  } else if (width == 16) {
    dataView.setUint16(0, int);
  } else {
    dataView.setUint32(0, int);
  }
  return buffer;
}

export class ByteStream extends ReadableStream<Uint8Array> {
  constructor(message: IPCMessage) {
    super(<any> message);
  }

  public async allBytes(): Promise<Uint8Array> {
    const allBytes = [];
    for await (const bytes of this) {
      allBytes.push(...bytes);
    }
    return new Uint8Array(allBytes);
  }
}

export type AddProviderValueOptions = { force?: never, ifNotFull: true } | { force: true, ifNotFull?: never };

type OutgoingMessageArgs = [0, bigint, string] // get provider value
  | [1, bigint, string, JsonType, AddProviderValueOptions | undefined] // add provider value
  | [2, bigint, string, JsonType] // log message
  | [3, bigint, bigint] // get response body
  | [4, bigint] // create util function result
  | [5, bigint, number | string] // create endpoint pre function result
  | [6, bigint, number | string] // create endpoint post function result
  | [7, bigint, JsonType | string | undefined] // call endpoint pre function result
  | [8, bigint, string?]; // call endpoint post function result

export function encodeOutgoingMessage(opCode: 0, requestId: bigint, name: string): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 1, requestId: bigint, name: string, value: JsonType, options: AddProviderValueOptions | undefined): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 2, requestId: bigint, name: string, value: JsonType): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 3, requestId: bigint, responseId: bigint): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 4, responseId: bigint): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 5, responseId: bigint, result: number | string): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 6, responseId: bigint, result: number | string): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 7, responseId: bigint, result: JsonType | string | undefined): [Uint8Array, bigint];
export function encodeOutgoingMessage(opCode: 8, responseId: bigint, result?: string): [Uint8Array, bigint];
export function encodeOutgoingMessage(...args: OutgoingMessageArgs): [Uint8Array, bigint];
export function encodeOutgoingMessage(...args: OutgoingMessageArgs): [Uint8Array, bigint] {
  let bytes: Uint8Array;
  let id: bigint;
  const opCode = args[0];
  if (args[0] == 0) {
    id = args[1];
    bytes = new Uint8Array(args[2].length * 3 + HeaderBuffer.HEADER_SIZE);
    bytes = encodeString(args[2], bytes, HeaderBuffer.HEADER_SIZE + 1);
  } else if (args[0] == 1 || args[0] == 2) {
    id = args[1];
    const json = args[4]
      ? JSON.stringify([args[2], args[3], args[4]])
      : JSON.stringify([args[2], args[3]]);
    bytes = new Uint8Array(json.length * 3 + HeaderBuffer.HEADER_SIZE);
    bytes = encodeString(json, bytes, HeaderBuffer.HEADER_SIZE + 1);
  } else if (args[0] == 3) {
    id = args[1];
    bytes = new Uint8Array(8 + HeaderBuffer.HEADER_SIZE);
    new DataView(bytes.buffer).setBigUint64(HeaderBuffer.HEADER_SIZE, args[2] << 8n);
    bytes = bytes.subarray(0, HeaderBuffer.HEADER_SIZE + 7);
  } else if (args[0] == 4) {
    id = args[1];
    bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE);
  } else if (args[0] == 5 || args[0] == 6) {
    id = args[1];
    const json = JSON.stringify(args[2]);
    bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE + json.length * 3)
    bytes = encodeString(json, bytes, HeaderBuffer.HEADER_SIZE + 1);
  } else if (args[0] == 7) {
    id = args[1];
    if (args[2]) {
      const json = JSON.stringify(args[2]);
      bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE + json.length * 3);
      bytes = encodeString(json, bytes, HeaderBuffer.HEADER_SIZE + 1);
    } else {
      bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE);
    }
  } else {
    id = args[1];
    if (args[2]) {
      bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE + args[2].length * 3);
      bytes = encodeString(args[2], bytes, HeaderBuffer.HEADER_SIZE + 1);
    } else {
      bytes = new Uint8Array(HeaderBuffer.HEADER_SIZE);
    }
  }
  const dvBytes = new DataView(bytes.buffer);
  HeaderBuffer.setBits({ end: true, id, bodySize: bytes.byteLength - HeaderBuffer.HEADER_SIZE, opCode }, dvBytes);
  return [bytes, id];
}

export async function* decodeIncomingMessages(reader: Deno.Reader): AsyncGenerator<[Header, Uint8Array], void, undefined> {
  const headerBuffer = new HeaderBuffer();
  let header: Header | undefined;
  let bodyBuffer: BodyBuffer | undefined;
  
  while (true) {
    let buffer = bodyBuffer ?? headerBuffer;
    let n = await reader.read(buffer.nextSection());
    if (n == null) {
      return;
    } else {
      buffer.incrementOffset(n);
    }
    if (buffer.bytesRemaining) {
      continue;
    }
    if (buffer == bodyBuffer) {
      yield [header!, buffer.body];
      bodyBuffer = undefined;
    } else {
      header = headerBuffer.toHeader();
      bodyBuffer = new BodyBuffer(header.bodySize);
    }
  }
}