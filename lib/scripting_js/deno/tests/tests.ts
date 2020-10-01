import { sendOutgoingMessage, Header, HeaderBuffer, resolvablePromise, ResolvablePromise } from "../src/message.ts";
// import estree from "https://dev.jspm.io/@typescript-eslint/typescript-estree";
// import estree from "https://cdn.pika.dev/@typescript-eslint/typescript-estree@^3.6.1";

import { assertEquals, assert } from "https://deno.land/std@0.64.0/testing/asserts.ts";
import { encodeOutgoingMessage, decodeIncomingMessages, decodeString, decodeBigUint, decodeUint } from "../src/byteUtils.ts";

Deno.test("HeaderBuffer should properly parse header bytes", () => {
  const headers: Header[] = [
    {
      end: true,
      id: 4n,
      bodySize: 1891,
      opCode: 0
    },
    {
      end: false,
      id: BigInt(Number.MAX_SAFE_INTEGER),
      bodySize: Number.parseInt("1".repeat(15), 2),
      opCode: 46
    },
    {
      end: true,
      id: BigInt(`0b${"".padStart(55, "1")}`),
      bodySize: 0,
      opCode: 255
    },
  ];
  
  for (const header of headers) {
    const header2 = new HeaderBuffer(header).toHeader();
    assertEquals(header2, header, "headers should match");
  }
});

class ClosableBuffer extends Deno.Buffer implements Deno.Closer {
  #closed = false;
  #pendingReads: ResolvablePromise<number | null>[] = [];

  close() {
    this.#closed = true;
    for (const p of this.#pendingReads) {
      p.resolve(null);
    }
  }

  async read(p: Uint8Array) {
    if (this.#closed) {
      return null;
    } else {
      const promise = resolvablePromise(super.read(p));
      const i = this.#pendingReads.push(promise);
      const result = await promise;
      this.#pendingReads.splice(i, 1);
      return result;
    }
  }
}

Deno.test("Outgoing messages should be encoded properly", async () => {
  const args: Parameters<typeof sendOutgoingMessage>[] = [
    [0, 0n, "foo"],
    [1, 0n, "foo", { zed: 123 }, undefined],
    [2, 0n, "log", { some: "thing" }],
    [3, 0n, 9152n],
    [4, 0n],
    [5, BigInt(Number.MAX_SAFE_INTEGER), 27],
    [6, 0n, 17],
    [7, 42n, "error"],
    [7, 42n, { a: { result: "object" } }],
    [7, 42n, undefined],
    [8, 0n],
    [8, 0n, "error"],
  ];

  const sink = new ClosableBuffer();
  const incoming = decodeIncomingMessages(sink);

  for (const a of args) {
    const [bytes, requestId] = encodeOutgoingMessage(...a);
    await sink.write(bytes);
    const [header, bodyBytes] = <[Header, Uint8Array]> (await incoming.next()).value;
    assertEquals(a[0], header.opCode, "opCodes should match");
    assertEquals(header.id, requestId, "requestIds should match");
    assertEquals(header.bodySize, bytes.byteLength - HeaderBuffer.HEADER_SIZE, "body size should match");
    assertEquals(header.bodySize, bodyBytes.byteLength, "body size should match");
    assert(header.end, "header should indicate end of message");
    if (a[0] == 0) {
      const s = decodeString(bodyBytes);
      assertEquals(s, a[2]);
    } else if (a[0] == 1 || a[0] == 2) {
      const [name, json] = JSON.parse(decodeString(bodyBytes));
      assertEquals(name, a[2]);
      assertEquals(json, a[3]);
    } else if (a[0] == 3) {
      const n = decodeBigUint(bodyBytes, 55);
      assertEquals(n, a[2]);
    } else if (a[0] == 4) {
      assertEquals(bodyBytes.byteLength, 0);
    } else if (a[0] == 5 || a[0] == 6) {
      const json = decodeString(bodyBytes);
      const value = JSON.parse(json);
      assertEquals(value, a[2]);
    } else if (a[0] == 7) {
      if (bodyBytes.byteLength > 0) {
        const json = decodeString(bodyBytes);
        const value = JSON.parse(json);
        assertEquals(value, a[2]);
      } else {
        assertEquals(a[2], undefined);
      }
    } else if (a[0] == 8) {
      if (bodyBytes.byteLength > 0) {
        const s = decodeString(bodyBytes);
        assertEquals(s, a[2]);
      } else {
        assertEquals(a[2], undefined);
      }
    }
  }
});

// Deno.test("test worker import abilities", async () => {
//   // TODO: util, pre and post functions:
//   //    - have a worker run per number of cpu cores
//   //    - have Deno.compile compile all TypeScript functions
//   //    - run JavaScript code through AST to verify each function is a single function
//   //    - have every util, pre and post function eval into every worker. This should be done so
//   //      each pre and post function have the same id across all workers
//   //    - incoming messages to call a pre or post function will be handed off to a worker
//   //    - when a worker needs to get or set a provider or log something the request will be tied
//   //      to the worker so the pre/post function can resume where it left off
//   //    - while a worker is `await`ing for get/set provider or to log something, it can handle
//   //      simultaneous pre/post function calls
//   //    - the main thread will keep track of which worker threads are busy and how many pending
//   //      (`await`ing) tasks there are on each one
//   //    - the main thread will hand off incoming pre and post calls to whichever available worker
//   //      has the fewest number of pending tasks

//   const [diagnostics, emitMap] = await Deno.compile("/0.ts", {
//     "/0.ts": `
//     /// <reference no-default-lib="true"/>
//     /// <reference lib="es2020"/>
//     import type { Providers } from "/bar.ts";

//     function foo(a: number) {
//       a.push(1.2);
//       return "hi";
//     }

//     (async function(providers: Providers) {
//       let f = providers.set("foo", {});

//     })`,
//     "/bar.ts": `
//       export interface Providers {
//         get(s: string): Promise<void>;
//       }
//     `
//   },
//   {
//     lib: ["dom", "es2020"],
//     sourceMap: false,
//   });

//   console.log(diagnostics, emitMap);

//   // const [diagnostics, emitMap] = await Deno.compile("/foo.ts", {
//   //   "/foo.ts": `
//   //   /// <reference no-default-lib="true"/>
//   //   /// <reference lib="es2020"/>

//   //   import {bar, Providers} from "./bar.ts";
//   //   console.log(bar);

//   //   declare const providers: Providers;
    
//   //   (async function() {
//   //     let f = providers.set("foo", {});
//   //   })

//   //   `,
//   //   "/bar.ts": `
//   //   export const bar = "bar";
//   //   export interface Providers {
//   //     get(s: string): Promise<void>;
//   //   }
//   //   `,
//   // });
  
//   // console.log(diagnostics, emitMap);


//   const worker = new Worker(new URL("./worker.js", import.meta.url).href, {type: "module"});
//   await new Promise((resolve) => setTimeout(resolve, 1000));
//   worker.terminate();
// });

// Deno.test("test parsing typescript", () => {
//   const fn = `
//     () => {
//       const a = <Foo> null;
//       eval("alert('foo')");
//     }
//   `;
//   console.log(
//     Deno.inspect(
//       (<any> estree).parse(fn),
//       { depth: Infinity }
//     )
//   );
// });