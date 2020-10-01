import { encodeOutgoingMessage } from "./byteUtils.ts";

type JsonTypeValue<T> = { [key: string]: string | number | null | T };
export interface JsonType extends JsonTypeValue<JsonType> {};

export interface Header {
  end: boolean;
  id: bigint;
  bodySize: number;
  opCode: number;
}

export class HeaderBuffer {
  #bytes = new DataView(new ArrayBuffer(HeaderBuffer.HEADER_SIZE));
  #offset: number = 0;
  static HEADER_SIZE = 10;

  get bytesRemaining(): boolean {
    return this.#bytes.byteLength > this.#offset;
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.#bytes.buffer);
  }

  constructor();
  constructor(header: Header);
  constructor(header?: Header) {
    if (header) {
      this.setBits(header)
    }
  }

  /// consumes this buffer and parses the data
  toHeader(): Header {
    // only want 7 bytes, so get 8 and drop the last byte
    const leadingBytes = this.#bytes.getBigUint64(0) >> 8n;
    // body size is two bytes at index 7
    const bodySize = this.#bytes.getUint16(7);
    // the "finished" flag is the last bit of the first 7 bytes
    const end = !!(leadingBytes & 1n);
    // id is the first 55 bits
    const id = leadingBytes >> 1n;
    const opCode = this.#bytes.getUint8(9);
    this.#offset = 0;

    return { end, id, bodySize, opCode };
  }

  static setBits(header: Header, bytes: DataView) {
    // set the bits for the id
    bytes.setBigUint64(0, header.id << 9n);
    // set the bits for the bodySize
    bytes.setUint16(7, header.bodySize);
    if (header.end) {
      // set the finished bit (get the 7th byte and set the right most bit)
      new Uint8Array(bytes.buffer)[6] |= 1;
    }
    bytes.setUint8(9, header.opCode);
  }

  setBits(header: Header): HeaderBuffer {
    HeaderBuffer.setBits(header, this.#bytes);
    return this;
  }

  nextSection(): Uint8Array {
    return new Uint8Array(this.#bytes.buffer, this.#offset);
  }

  incrementOffset(n: number) {
    this.#offset += n;
  }
}

export type ResolvablePromise<T> = Promise<T> & { resolve: (_: T) => void };

export function resolvablePromise<T>(p?: Promise<T>): ResolvablePromise<T> {
  let resolve;
  const promise: any = p
    ? new Promise((r) => {
        p.then((t) => r(t));
        resolve = r;
      })
    : new Promise((r) => {
        resolve = r;
      });
  promise.resolve = resolve;
  return promise;
}

export class IPCMessage implements UnderlyingByteSource {
  type: "bytes" = "bytes";
  #controller?: ReadableByteStreamController;
  #bytesAvailable = resolvablePromise<void>();
  #bytes: Uint8Array[] = [];
  #done = false;
  #pulledOnce = false;
  #onInterestCb?: () => void;

  onInterest(cb: () => void) {
    this.#onInterestCb = cb;
  }

  start(controller: ReadableByteStreamController) {
    this.#controller = controller;
    if (this.#done) {
      controller.close();
    } else {
      for (const bytes of this.#bytes) {
        controller.enqueue(bytes);
      }
    }
    this.#bytes.length = 0;
  }

  async pull(controller: ReadableByteStreamController): Promise<void> {
    if (!this.#pulledOnce && this.#onInterestCb) {
      this.#pulledOnce = true;
      this.#onInterestCb();
    }
    await this.#bytesAvailable;
    this.#bytesAvailable = resolvablePromise();
  }

  public pipe(bytes: Uint8Array) {
    if (this.#controller) {
      this.#controller.enqueue(bytes)
    } else {
      this.#bytes.push(bytes);
    }
    this.#bytesAvailable.resolve();
  }

  public end() {
    this.#done = true;
    if (this.#controller) {
      this.#controller.close();
    }
  }
}

export class BodyBuffer {
  #bytes: Uint8Array;
  #offset: number = 0;

  get body(): Uint8Array {
    return this.#bytes;
  }

  get bytesRemaining(): boolean {
    return this.#bytes.byteLength > this.#offset;
  }

  constructor(bytesLength: number) {
    this.#bytes = new Uint8Array(bytesLength);
  }

  nextSection(): Uint8Array {
    return this.#bytes.subarray(this.#offset);
  }

  incrementOffset(n: number) {
    this.#offset += n;
  }
}

export async function sendOutgoingMessage(...args: Parameters<typeof encodeOutgoingMessage>): Promise<void> {
  const [bytes, id] = encodeOutgoingMessage(...args);
  await Deno.stdout.write(bytes);
}