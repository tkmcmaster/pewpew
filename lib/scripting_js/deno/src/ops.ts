import { decodeString, decodeUint, AddProviderValueOptions, ByteStream } from "./byteUtils.ts";
import { evil } from "./eval.ts";
import { resolvablePromise, sendOutgoingMessage, Header, IPCMessage, ResolvablePromise } from "./message.ts";
import { JsonType } from "../pewpew.ts";

type ErrorMessage = string;

export async function getProviderValue(name: string): Promise<JsonType> {
  const promise = resolvablePromise<JsonType>();
  const requestId = await sendOutgoingMessage(0, name);
  waitingForResponse.set(requestId, promise);
  return await promise;
}

export async function addProviderValue(name: string, value: JsonType, options?: AddProviderValueOptions): Promise<void> {
  await sendOutgoingMessage(1, name, value, options);
}

export async function logMessage(name: string, msg: JsonType): Promise<void> {
  await sendOutgoingMessage(2, name, msg);
}

const unfinishedRequests = new Map<bigint, number[]>();

const ops = [
  createUtilFunction, // 0
  createEndpointPreFunction, // 1
  createEndpointPostFunction, // 2
  callEndpointPreFunction, // 3
  callEndpointPostFunction, // 4
  getProviderValueResult, // 5
  addProviderValueResult, // 6
  logMessageResult, // 7
  getResponseBodyResult, // 8
];

export function receiveOp(header: Header, body: Uint8Array) {
  const requestId = header.id;
  ops[header.opCode](requestId, body, header.end);
}

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

async function createUtilFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    const fn = decodeString(allBytes);
    const result = await _createUtilFunction(fn);
    sendOutgoingMessage(4, requestId);
  }
}

async function createEndpointFunction(bytes: Uint8Array, pre: boolean): Promise<string | number> {
  const fn = decodeString(bytes);
  return pre ? await _createEndpointPreFunction(fn) : await _createEndpointPostFunction(fn);
}

async function createEndpointPreFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  let response = await createEndpointFunction(await stream.allBytes(), true);
  // TODO: change this so it's either always a number (valid function) or can return string
  sendOutgoingMessage(5, requestId, <number> response);
}

async function createEndpointPostFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  let response = await createEndpointFunction(await stream.allBytes(), false);
  // TODO: change this so it's either always a number (valid function) or can return string
  sendOutgoingMessage(6, requestId, <number> response);
}

async function callEndpointPreFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  // TODO: don't gather all bytes, just forward on to worker
  // old code below
  // const bytes = await stream.allBytes();
  // const fnId = decodeUint(bytes, 16);
  // let result = await _callEndpointPreFunction(fnId);
  // sendOutgoingMessage(7, requestId, result);
}

const pendingResponseBodies = new Map<bigint, ResolvablePromise<ByteStream>>();

async function callEndpointPostFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  // TODO: don't gather all bytes, just forward on to worker
  // old code below
  // const bytes = await stream.allBytes();
  // const fnId = decodeUint(bytes, 16);
  // const bodyData = new IPCMessage();
  // bodyData.onInterest(async () => {
  //   const requestId2 = await sendOutgoingMessage(3, requestId);
  //   const promise = resolvablePromise<ByteStream>();
  //   pendingResponseBodies.set(requestId2, promise);
  //   const stream = await promise;
  //   for await (const bytes of stream) {
  //     bodyData.pipe(bytes);
  //   }
  //   bodyData.end();
  // });
  // const body = new ByteStream(bodyData);
  // const responseInit = JSON.parse(decodeString(bytes.subarray(16)));
  // const response = new Response(body, responseInit);
  // let result = await _callEndpointPostFunction(fnId, response);
  // sendOutgoingMessage(8, requestId, result);
}

const waitingForResponse = new Map<bigint, ResolvablePromise<JsonType>>();

async function getProviderValueResult(requestId: bigint, bytes: Uint8Array, end: boolean) {
  const promise = waitingForResponse.get(requestId);
  waitingForResponse.delete(requestId);
  if (promise) {
    const value = JSON.parse(decodeString(await stream.allBytes()));
    promise.resolve(value);
  }
}

async function addProviderValueResult(_requestId: bigint, _stream: ByteStream) {
  // noop
}

async function logMessageResult(_requestId: bigint, _stream: ByteStream) {
  // noop
}

async function getResponseBodyResult(requestId: bigint, bytes: Uint8Array, end: boolean) {
  const promise = pendingResponseBodies.get(requestId);
  pendingResponseBodies.delete(requestId);
  if (promise) {
    promise.resolve(stream);
  }
}

const utilFunctions: Record<string, (..._: any[]) => any> = {};
const preFunctions: Array<() => Promise<JsonType | undefined>> = [];
const postFunctions: Array<(response: Response) => Promise<undefined>> = [];

async function _createUtilFunction(fn: string): Promise<ErrorMessage | undefined> {
  try {
    let fn2: (..._: any[]) => any = evil(fn);
    utilFunctions[fn2.name] = fn2;
  } catch (e) {
    return e.toString();
  }
}

async function _createEndpointPreFunction(fnBody: string): Promise<number | ErrorMessage> {
  try {
    const fn = evil(`(async function() {${fnBody}})`);
    return preFunctions.push(fn) - 1;
  } catch (e) {
    return e.toString();
  }
}

async function _createEndpointPostFunction(fnBody: string): Promise<number | ErrorMessage> {
  try {
    const fn = evil(`(async function(response) {${fnBody}})`);
    return postFunctions.push(fn) - 1;
  } catch (e) {
    return e.toString();
  }
}

async function _callEndpointPreFunction(fnId: number): Promise<JsonType | ErrorMessage | undefined> {
  try {
    const fn = preFunctions[fnId];
    return fn ? await fn() : `invalid pre function id '${fnId}'`;
  } catch (e) {
    return e.toString();
  }
}

async function _callEndpointPostFunction(fnId: number, response: Response): Promise<ErrorMessage | undefined> {
  try {
    const fn = postFunctions[fnId];
    return fn ? await fn(response) : `invalid post function id '${fnId}'`;
  } catch (e) {
    return e.toString();
  }
}