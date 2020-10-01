import { decodeString } from "./byteUtils.ts";
import { sendOutgoingMessage, Header } from "./message.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module" });

worker.addEventListener("message", (e: any) => {
  console.error("received message from worker", e);
  const { ready, ipc } = e.data;
  if (ipc) {
    sendOutgoingMessage(...ipc);
  }
  if (ready !== undefined) {
    console.error({ready});
    // TODO: when there's a stack of workers, add this worker back to the stack based
    //       on the number of ops in progress
  }
});

worker.postMessage({foo: 1});
worker.postMessage({foo: 1});
worker.postMessage({foo: 1});

worker.onerror = (e) => {
  console.error("worker error", e);
};

worker.onmessageerror = (e) => {
  console.error("worker message error", e);
};

const localOps = [
  createEnv, // 0
  createEndpointPreFunction, // 1
  createEndpointPostFunction, // 2
];

export async function receiveOp(header: Header, body: Uint8Array) {
  const { opCode, end, id: requestId } = header;
  if (header.opCode < 3) {
    localOps[header.opCode](requestId, body, header.end);
  } else {
    if (!createdEnv) {
      // const tsCode = `(function ()  {
      //   ${env}
      //   const preFunctions: Array<(providers: Providers) => Promise<JsonType | undefined>> = [${preFunctions.join(",")}];
      //   const postFunctions: Array<(providers: Providers, request: Request, response: Response) => Promise<JsonType | undefined>> = [${postFunctions.join(",")}];
      //   return [preFunctions, postFunctions];
      // })()`;
      try {
      //   const [diagnostics, emitMap] = await Deno.compile("/0.ts", { "/0.ts": tsCode });
      //   const code = emitMap["/0.js"];
      //   // console.error(diagnostics);
      //   console.error("send worker init message");
      //   worker.postMessage({ opCode: 0, data: code, end: true, requestId: -1});
      //   createdEnv = true;
      } catch (e) {
        console.error("error with Deno.compile", e);
        Deno.exit(1);
      }
    }
    console.error("send worker message");
    worker.postMessage({ opCode, data: body, end, requestId }, [body]);
  }
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

let createdEnv = false;
let env = "";

async function createEnv(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    env = decodeString(allBytes);
  }
}


const preFunctions: string[] = [];
async function createEndpointPreFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    let fn = decodeString(allBytes);
    // TODO: add types so diagnostics should be empty
    // TODO: parse to AST to ensure it's a proper function
    fn = `async function(providers: Providers): Promise<JsonType | undefined> {${fn}}`;
    let n = preFunctions.push(fn) - 1;
    // TODO: change this so it's either always a number (valid function) or a string for error
    sendOutgoingMessage(5, requestId, n);
  }
}

const postFunctions: string[] = [];
async function createEndpointPostFunction(requestId: bigint, bytes: Uint8Array, end: boolean): Promise<void> {
  const allBytes = gatherAllBytes(requestId, bytes, end);
  if (allBytes) {
    let fn = decodeString(allBytes);
    // TODO: parse to AST to ensure it's a proper function
    fn = `async function(providers: Providers, request: Request, response: Response): Promise<JsonType | undefined> {${fn}}`;
    let n = postFunctions.push(fn) - 1;
    // TODO: change this so it's either always a number (valid function) or a string for error
    sendOutgoingMessage(6, requestId, n);
  }
}