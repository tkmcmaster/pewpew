import { decodeString, decodeUint, encodeOutgoingMessage, AddProviderValueOptions, ByteStream } from "./byteUtils.ts";
import { resolvablePromise, IPCMessage, JsonType, ResolvablePromise } from "./message.ts";
import { evalEnv } from "./eval.ts";

let preFunctions: Array<(providers: Providers) => Promise<JsonType | undefined>>;
let postFunctions: Array<(providers: Providers, request: Request, response: Response) => Promise<JsonType | undefined>>;

const ops = [
  createEnv, // 0
  noop, // 1
  noop, // 2
  callPreFunction, // 3
  callPostFunction, // 4
  getProviderValueResult, // 5
  addProviderValueResult, // 6
  logMessageResult, // 7
  getResponseBodyResult, // 8
];

interface Providers {
  get(name: string): Promise<JsonType>;
  set(name: string, value: JsonType, options?: AddProviderValueOptions): Promise<boolean>;
}

const unfinishedRequests = new Map<bigint, number[]>();
// gather's all bytes for messages which span multiple requests. It only returns the accumulated bytes
// on the "end" request
function gatherAllBytes(requestId: bigint, bytes: Uint8Array, end: boolean): Uint8Array | undefined {
  const unfinishedRequest = unfinishedRequests.get(requestId);
  if (unfinishedRequest) {
    unfinishedRequest.push(...bytes);
    if (end) {
      unfinishedRequests.delete(requestId);
      bytes = new Uint8Array(unfinishedRequest);
    }
  } else if (!end) {
    unfinishedRequests.set(requestId, [...bytes]);
  }
  if (end) {
    return bytes;
  }
}

// simple counter to keep track of how many operations are in progress
class PendingOpCounter {
  #count = 0;

  get count(): number {
    return this.#count;
  }
  
  add(op: Promise<any>) {
    this.#count++;
    // decrement count when the op finishes
    op.finally(() => this.#count--);
  }
}

const pendingOps = new PendingOpCounter();

onmessage = (e) => {
  console.error("worker onmessage", e);
  const { opCode, data, end, requestId } = e.data;
  const fn = ops[opCode];
  // fn(data, end, requestId);
  postMessage({ ready: pendingOps.count })
  console.error("after postmessage");
};

function noop() {}

function createEnv(code: string) {
  const [pre, post] = evalEnv(code);
  preFunctions = pre;
  postFunctions = post;
}

const pendingGetProviderResponse = new Map<bigint, ResolvablePromise<JsonType>>();
const pendingSetProviderResponse = new Map<bigint, ResolvablePromise<boolean>>();

const providers: Providers = {
  get(name: string): Promise<JsonType> {
    const requestId = workerRequestId++;
    sendOutgoingMessage(0, requestId, name);
    const promise = resolvablePromise<JsonType>();
    pendingGetProviderResponse.set(requestId, promise);
    return promise;
  },
  set(name: string, value: JsonType, options?: AddProviderValueOptions): Promise<boolean> {
    const requestId = workerRequestId++;
    sendOutgoingMessage(1, requestId, name, value, options);
    const promise = resolvablePromise<boolean>();
    pendingSetProviderResponse.set(requestId, promise);
    return promise;
  }
};

let workerRequestId = 0n;

function sendOutgoingMessage(...args: Parameters<typeof encodeOutgoingMessage>) {
  postMessage({ ipc: args });
}

function callPreFunction(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    const fnId = decodeUint(allBytes, 16);
    let op = preFunctions[fnId](providers);
    pendingOps.add(op);
    op.then(() => {
      sendOutgoingMessage(7, requestId, undefined);
    }).catch((e) => {
      sendOutgoingMessage(7, requestId, e.toString());
    });
  }
}

const pendingResponseBodies = new Map<bigint, IPCMessage>();

function callPostFunction(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    const fnId = decodeUint(allBytes, 16);
    const bodyData = new IPCMessage();
    bodyData.onInterest(async () => {
      const requestId2 = workerRequestId++;
      sendOutgoingMessage(3, requestId2, requestId);
      pendingResponseBodies.set(requestId2, bodyData);
    });
    const body = new ByteStream(bodyData);
    const {response: responseInit, request: requestInit} = JSON.parse(decodeString(allBytes.subarray(16)));
    const response = new Response(body, responseInit);
    const request = new Request(requestInit.url, requestInit);
    let op = postFunctions[fnId](providers, request, response);
    pendingOps.add(op);
    op.then(() => {
      sendOutgoingMessage(8, requestId);
    }).catch((e) => {
      sendOutgoingMessage(8, requestId, e.toString());
    });
  }
}

const waitingSimpleResults = new Map<bigint, ResolvablePromise<any>>();

function getProviderValueResult(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const promise = pendingGetProviderResponse.get(requestId);
  if (promise) {
    const allBytes = gatherAllBytes(requestId, bytes, end);
    if (allBytes) {
      const result = JSON.parse(decodeString(allBytes));
      promise.resolve(result);
      pendingGetProviderResponse.delete(requestId);
    }
  }
}

function addProviderValueResult(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const promise = pendingSetProviderResponse.get(requestId);
  if (promise) {
    const allBytes = gatherAllBytes(requestId, bytes, end);
    if (allBytes) {
      const result = decodeUint(allBytes, 8) == 1;
      promise.resolve(result);
      pendingSetProviderResponse.delete(requestId);
    }
  }
}

function logMessageResult(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const promise = waitingSimpleResults.get(requestId);
  if (promise) {
    const allBytes = gatherAllBytes(requestId, bytes, end);
    if (allBytes) {
      const result = decodeUint(allBytes, 8) == 1;
      promise.resolve(result);
      waitingSimpleResults.delete(requestId);
    }
  }
}

function getResponseBodyResult(bytes: Uint8Array, end: boolean, requestId: bigint) {
  const bodyData = pendingResponseBodies.get(requestId);
  if (bodyData) {
    bodyData.pipe(bytes);
    if (end) {
      bodyData.end();
      pendingResponseBodies.delete(requestId);
    }
  }
}